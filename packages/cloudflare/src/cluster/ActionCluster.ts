import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import type * as Event from "@gjermundgaraba/effect-actions/Event";
import * as Stored from "@gjermundgaraba/effect-actions/Stored";
import {
  Cause,
  Context,
  Effect,
  Function,
  Layer,
  ManagedRuntime,
  Option,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { ClusterSchema, Sharding } from "effect/cluster";
import { Headers, HttpEffect, HttpRouter } from "effect/http";
import type { HttpServerRequest } from "effect/http";
import { SqlClient } from "effect/sql";

import { changedIn, objectHere, stateHere } from "./objects.js";
import type { Recorded } from "./objects.js";

type Answer =
  | Effect.Effect<unknown, unknown, unknown>
  | Stream.Stream<unknown, unknown, unknown>;

type Method = (payload: unknown, options?: unknown) => Answer;

const intact = (answer: Answer) =>
  Effect.isEffect(answer)
    ? Effect.provideService(answer, Headers.CurrentRedactedNames, [])
    : Stream.provideService(answer, Headers.CurrentRedactedNames, []);

/**
 * Effect Cluster on Durable Objects, `CloudflareCluster.layer(options)`, whose entity clients
 * send a volatile call's headers as the caller set them: the `Sharding`, the `WorkflowEngine` and
 * the `PersistedQueueFactory` it provides, its `Sharding`'s entity clients each sending a call of
 * an rpc not annotated `ClusterSchema.Persisted` with `Headers.CurrentRedactedNames` empty.
 * Provide it where `CloudflareCluster.layer` goes, so a credential `ActionEntity.reaching` or
 * `RpcClient.withHeaders` sends reaches the entity. Guide: `docs/ActionCluster.md` in this
 * package.
 *
 * **Gotchas**
 *
 * - `CloudflareCluster.layer`'s own clients send `authorization`, `cookie`, `set-cookie` and `x-api-key` as the text `<redacted>`, so an entity authenticating from its envelope refuses every protected call with `Unauthenticated`: this layer is the fix until Effect sends them intact.
 * - A persisted rpc's call, one whose rpc is annotated `ClusterSchema.Persisted`, as `CloudflareCluster.layer` reads it, is sent as `CloudflareCluster.layer` sends it, redacted, since `cluster_messages` keeps its envelope: its handler receives `<redacted>`, and a protected one is refused with `Unauthenticated`, so authenticate nothing from a persisted tell's headers.
 * - Redaction is off for a volatile call alone, its send and its wait for the answer, in the caller's fiber: the caller's logs before and after it, and the entity's own, still redact those headers.
 * - Each entity's build runs with `Stored.ChangeListener` telling the object's socket host of each change `Stored.layerEvents` makes there, so a parked poll is asked again as its events change; on Effect's own `ClusterEntity` class, which records no state, the listener does nothing.
 */
export const layer = (
  options: CloudflareCluster.LayerOptions
): Layer.Layer<Layer.Success<ReturnType<typeof CloudflareCluster.layer>>> =>
  Layer.effect(Sharding.Sharding)(
    Effect.map(Effect.service(Sharding.Sharding), (sharding) =>
      Sharding.Sharding.of({
        ...sharding,
        registerEntity: (entity, build, registerOptions) =>
          sharding.registerEntity(
            entity,
            Effect.flatMap(objectHere, (object) =>
              object === undefined
                ? build
                : Effect.provideService(build, Stored.ChangeListener, () => {
                    changedIn(object.storage);
                  })
            ),
            registerOptions
          ),
        makeClient: (entity) =>
          Effect.map(
            sharding.makeClient(entity),
            (clientFor) => (entityId: string) => {
              const client = clientFor(entityId);

              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              const methods = client as Readonly<
                Record<string, Method | undefined>
              >;

              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              return Object.fromEntries(
                [...entity.protocol.requests.values()].flatMap((rpc) => {
                  const method = methods[rpc._tag];

                  if (method === undefined) {
                    return [];
                  }

                  return Context.get(rpc.annotations, ClusterSchema.Persisted)
                    ? [[rpc._tag, method] as const]
                    : [
                        [
                          rpc._tag,
                          (payload: unknown, sendOptions?: unknown) =>
                            intact(method(payload, sendOptions)),
                        ] as const,
                      ];
                })
              ) as typeof client;
            }
          ),
      })
    )
  ).pipe(Layer.provideMerge(CloudflareCluster.layer(options)));

/**
 * The entity object's own SQL client, `@effect/platform-cloudflare`'s
 * `CloudflareCluster.DurableObjectSqlClient`, under its key: an `@effect/sql-sqlite-do` `SqlClient` over the
 * Durable Object's SQLite storage, which an entity's build, its `services`, its handlers and the
 * fibers they fork read with `ActionCluster.Sql.orDie`, and `layerObject` provides as `SqlClient`.
 * Guide: `docs/ActionCluster.md` in this package.
 *
 * **Gotchas**
 *
 * - It is the runtime's service under the package's own class, one key for both: a test provides it from any SQL layer, `Layer.succeed(ActionCluster.Sql, client)`, and the runtime's `DurableObjectSqlClient` reads that too.
 * - Read outside an entity's Durable Object, as in the Worker's routes, `orDie` dies: build what reads it in `ActionEntity.layer`'s `services`.
 * - `withTransaction` closes the object's input gate until it ends, so a timer or I/O awaited inside it never resumes: keep a transaction to SQL work.
 * - Tables whose names start with `cluster_` are the runtime's mailbox: write none.
 */
export class Sql extends Context.Service<Sql, SqlClient.SqlClient>()(
  CloudflareCluster.DurableObjectSqlClient.key
) {
  /** The entity object's SQL client, or a defect where no entity's Durable Object provides one. */
  static readonly orDie: Effect.Effect<SqlClient.SqlClient> =
    CloudflareCluster.DurableObjectSqlClient.orDie;
}

/**
 * The entity object's database as an entity's `services` read it, built per activation: `Sql` as
 * `SqlClient`, and `Stored.layerEvents` over it, keeping the entity's events in the object's
 * SQLite database. Provide it beneath the entity's own stores, as
 * `Layer.provideMerge(ActionCluster.layerObject)`. Guide: `docs/ActionCluster.md` in this package.
 *
 * **Gotchas**
 *
 * - Built outside an entity's Durable Object, as in the Worker's routes, it dies: build it in `ActionEntity.layer`'s `services`.
 * - Its `SqlClient` is the object's: a Worker route reading a separate database, such as D1, provides that one to its own layers instead.
 */
export const layerObject: Layer.Layer<SqlClient.SqlClient | Event.Events> =
  Stored.layerEvents.pipe(
    Layer.provideMerge(Layer.effect(SqlClient.SqlClient)(Sql.orDie))
  );

/**
 * The Durable Object state of the entity object running the effect that reads it: its `id`, whose
 * `name` is `CloudflareCluster.encodeName(type, id)`, its `storage`, `waitUntil`, which keeps the
 * object alive until a promise settles, such as work forked past the call that started it,
 * `abort`, which resets the object, and `database`, the object's SQLite storage for a library
 * written with Promises, such as pi's: `storage.sql`, and `transaction`, which runs a Promise
 * closure in a storage transaction behind the gate the runtime's mailbox writes wait on,
 * committing where it resolves and rolling back and rejecting with its own rejection where it
 * rejects. Read it with `ObjectState.orDie`, in an entity's build, its `services`, a handler or a
 * fiber either forks, on an object whose class is `ActionClusterEntity.make`'s or
 * `ActionClusterEntity.ClusterEntity`, which record it, the same object for each read in one
 * build; a test provides the service itself. Guide: `docs/ActionCluster.md` in this package.
 *
 * **Gotchas**
 *
 * - On an object of Effect's own `ClusterEntity` class, which records no state, `orDie` dies naming the class to export: export `ActionClusterEntity.ClusterEntity`, or `make`'s class, as `ClusterEntity` from the Worker's module.
 * - `storage.transaction()` and `transactionSync()` called directly skip the gate the runtime's mailbox writes wait on, so another call's reply written while yours is open is lost to your rollback: open one with `database.transaction`, or `Sql`'s `withTransaction` in an Effect.
 * - The runtime builds an entity's handlers again after a call died, and that build reads another `database`: work that outlived a call and kept the old one queues apart from the new build's, so a library's statement on one can land in the other's transaction.
 * - A statement on `database.sql` outside `database.transaction` takes no gate, so one run while another transaction is open lands in it and is lost to its rollback: hand every adapter the same `database`, as a library such as Chord queues its statements behind its transactions per object it is given.
 * - A timer or I/O awaited inside `database.transaction`'s closure never resumes, as the input gate the storage transaction closes holds it: keep the closure to SQL work.
 * - `database.transaction` awaited before `Sql`'s `withTransaction` returns, inside it, in its `afterCommit` callbacks or inside another `database.transaction`'s closure, waits forever on the gate the open one holds: await it only once the open transaction has returned.
 * - `database.transaction` cannot be cancelled: its closure runs once the gate frees even where its caller stopped waiting, without the caller's services or tracing; Effect work a caller owns opens `Sql`'s `withTransaction` instead.
 * - The runtime owns the object's alarm, for scheduled tells, replays and `Entity.keepAlive`: `storage.setAlarm` or `deleteAlarm` replaces its alarm and loses what it scheduled, and the class's `alarm` runs the runtime's; schedule work with a persisted tell carrying `DeliverAt` instead.
 * - Tables whose names start with `cluster_` are the runtime's mailbox: write none, and read them only as its tests do.
 * - `abort` ends every call under way on the object and evicts it; the next call builds it again, and the runtime replays its unprocessed persisted messages.
 */
export class ObjectState extends Context.Service<ObjectState, Recorded>()(
  "@gjermundgaraba/effect-actions-cloudflare/ActionCluster/ObjectState"
) {
  /** The state of the entity object running this, provided or recorded by its class, or a defect saying why there is none. */
  static readonly orDie: Effect.Effect<ObjectState["Service"]> = Effect.flatMap(
    Effect.serviceOption(ObjectState),
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        Effect.flatMap(objectHere, (object) => {
          if (object === undefined) {
            return Effect.die(
              new Error(
                "ActionCluster.ObjectState is read outside an entity's Durable Object: read it in an entity's build, services or handlers, or provide ObjectState in a test"
              )
            );
          }

          const state = stateHere(object.sql, object.storage);

          return state === undefined
            ? Effect.die(
                new Error(
                  "ActionCluster.ObjectState found no state recorded for this object: export ActionClusterEntity.ClusterEntity, or ActionClusterEntity.make's class, as ClusterEntity from the Worker's module, in place of Effect's own"
                )
              )
            : Effect.succeed(state);
        }),
    })
  );
}

/**
 * The function `CloudflareDurableObjects.setInitializer` takes, which `ActionClusterEntity.register` registers: it builds `application(env)`, with
 * `HttpRouter.layer` beneath it, in a `ManagedRuntime` of its own on each call, and keeps the first
 * runtime to finish for the isolate, disposing a failed one and leaving a later one alive for the
 * isolate's life, since it may hold the isolate's entity registrations. An application registers
 * it with `ActionClusterEntity.register`, and calls it itself only to test it. Guide: `docs/ActionCluster.md` in this
 * package.
 *
 * **Gotchas**
 *
 * - A build still pending after 15 seconds is abandoned and the initializer called again, and a stalled build that registered its entities refuses the replacement's, so the entities run in the stalled build's services, the Worker's routes in the kept one's, and a stall that then fails leaves the isolate serving no entity type: build nothing slow, such as a migration or a remote fetch, above `ActionCluster.layer`.
 * - A call whose build fails answers the runtime another call kept, and rejects with its failure when none was kept, so the next call builds again.
 */
export const initializer = <Env, A, E>(
  application: (env: Env) => Layer.Layer<A, E, HttpRouter.HttpRouter>
): ((env: Env) => Promise<Context.Context<A | HttpRouter.HttpRouter>>) => {
  let kept:
    | ManagedRuntime.ManagedRuntime<A | HttpRouter.HttpRouter, E>
    | undefined;

  const build = async (env: Env) => {
    const runtime = ManagedRuntime.make(
      application(env).pipe(Layer.provideMerge(HttpRouter.layer))
    );

    try {
      await runtime.context();
    } catch (error) {
      await runtime.dispose();

      if (kept === undefined) {
        throw error;
      }

      return kept;
    }

    kept ??= runtime;

    return kept;
  };

  return async (env) => await (kept ?? (await build(env))).context();
};

/** `handler`'s options. */
export interface HandlerOptions<Env> {
  /** The pages' WebSockets, each upgrade handed to an entity's object; without it, every request goes to the application's routes. */
  readonly sockets?:
    | {
        /** The `ClusterEntity` namespace, the one `ActionCluster.layer`'s `entityNamespace` is given. */
        readonly entityNamespace: (env: Env) => DurableObjectNamespace;
        /** The routes, tried in order before the application's routes. */
        readonly routes: ReadonlyArray<{
          /** The entity whose objects serve the sockets, one of `ActionClusterEntity.make`'s `sockets`. */
          readonly entity: ActionEntity.Any;
          /** The pathname matched, a `URLPattern` pathname such as `/rooms/:id/rpc`, whose group `id`, percent-decoded, holds the entity id, as `ActionEntity.reaching` keys a call's decoded input; a pattern naming no `id`, or a segment that does not decode, matches no request. */
          readonly path: string;
          /** The entity id for the decoded `id` group the page sent in `request`, or `undefined` to answer the request as one matching no route; by default, the decoded group. */
          readonly id?:
            | ((sent: string, request: Request) => string | undefined)
            | undefined;
        }>;
      }
    | undefined;
}

const decoded = (segment: string | undefined) => {
  try {
    return segment === undefined ? undefined : decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

const objectsOf = <Env>({
  entityNamespace,
  routes,
}: NonNullable<HandlerOptions<Env>["sockets"]>) => {
  const patterns = routes.map(({ entity, path, id = Function.identity }) => ({
    entity,
    id,
    pattern: new URLPattern({ pathname: path }),
  }));

  return (env: Env, request: Request) => {
    for (const { entity, id, pattern } of patterns) {
      const sent = decoded(pattern.exec(request.url)?.pathname.groups["id"]);
      const entityId = sent === undefined ? undefined : id(sent, request);

      if (entityId !== undefined) {
        return entityNamespace(env).getByName(
          CloudflareCluster.encodeName(entity.type, entityId)
        );
      }
    }

    return undefined;
  };
};

/**
 * The Worker's handler, its module's default export: a request whose pathname a route of
 * `sockets` matches, with an id that route admits, goes to the entity's object,
 * `entityNamespace(env).getByName(CloudflareCluster.encodeName(entity.type, id)).fetch(request)`,
 * and every other request is answered by the `HttpRouter` of the context `initialize` returns,
 * the function `ActionClusterEntity.register` returned. Guide:
 * `docs/ActionCluster.md` in this package.
 *
 * **Gotchas**
 *
 * - A socket route reaches the object without waiting on the initializer and judges nothing itself: the object answers a request that is no upgrade 426, an entity not in `ActionClusterEntity.make`'s `sockets` 404, and accepts any `Origin`, so refuse a page of another site in the route's `id`, which reads the request.
 */
export const handler = <Env>(
  initialize: (env: Env) => PromiseLike<Context.Context<HttpRouter.HttpRouter>>,
  options: HandlerOptions<Env> = {}
) => {
  const objectOf =
    options.sockets === undefined ? undefined : objectsOf(options.sockets);

  const serve = async (request: Request, env: Env) => {
    const context = await initialize(env);

    return await HttpEffect.toWebHandlerWith<
      HttpRouter.HttpRouter,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >(context)(Context.get(context, HttpRouter.HttpRouter).asHttpEffect())(
      request
    );
  };

  return {
    fetch: async (request: Request, env: Env): Promise<Response> => {
      const object = objectOf?.(env, request);

      return object === undefined
        ? await serve(request, env)
        : await object.fetch(request);
    },
  };
};

const clientClosedRequest = 499;

const isUnreached = (error: unknown) =>
  Action.isUnavailable(error) || ActionEntity.isClusterFailure(error);

/**
 * The web `Response` for a call a Worker made through an entity's client itself, outside any
 * surface, `Entity.client`, `ActionEntity.client` or `ActionEntity.nativeClient`, that failed with
 * `cause`. The entity was not reached, or did not answer in time, where the cause fails with
 * `Action.Unavailable` or a cluster failure `ActionEntity.isClusterFailure` matches, and no
 * defect: a 503 with `Retry-After: 1`. The request's client went away where the cause holds only
 * interrupts: a 499. Anything else is a 500, after logging the cause with `Effect.logError`.
 * None has a body. Guide: `docs/ActionCluster.md` in this package.
 *
 * **Gotchas**
 *
 * - A 503 tells the client to try again, though the entity may have run the call: send again only a call safe to repeat.
 * - A declared error of the call but `Unavailable`, which the Worker answers itself, is a 500 here, logged: catch it first.
 */
export const failureResponse = <E>(
  cause: Cause.Cause<E>
): Effect.Effect<Response> => {
  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.succeed(new Response(null, { status: clientClosedRequest }));
  }

  return !Cause.hasDies(cause) && isUnreached(Cause.squash(cause))
    ? Effect.succeed(
        new Response(null, { status: 503, headers: { "retry-after": "1" } })
      )
    : Effect.as(
        Effect.logError("A call to an entity failed", cause),
        new Response(null, { status: 500 })
      );
};
