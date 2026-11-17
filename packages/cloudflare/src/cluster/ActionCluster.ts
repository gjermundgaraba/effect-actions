import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import type * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as Stored from "@gjermundgaraba/effect-actions/Stored";
import {
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

import { changedIn, stateOf, storageHere } from "./objects.js";

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
            Effect.flatMap(storageHere, (storage) =>
              storage === undefined
                ? build
                : Effect.provideService(build, Stored.ChangeListener, () => {
                    changedIn(storage);
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
 * The Durable Object state of the entity object running the effect that reads it: its `id`, whose
 * `name` is `CloudflareCluster.encodeName(type, id)`, its `storage`, `waitUntil`, which keeps the
 * object alive until a promise settles, such as work forked past the call that started it, and
 * `abort`, which resets the object. Read it with `ObjectState.orDie`, in an entity's build, its
 * `services`, a handler or a fiber either forks, on an object whose class is
 * `ActionClusterEntity.make`'s or `ActionClusterEntity.ClusterEntity`, which record it; a test
 * provides the service itself. Guide: `docs/ActionCluster.md` in this package.
 *
 * **Gotchas**
 *
 * - On an object of Effect's own `ClusterEntity` class, which records no state, `orDie` dies naming the class to export: export `ActionClusterEntity.ClusterEntity`, or `make`'s class, as `ClusterEntity` from the Worker's module.
 * - `storage.transaction()` and `transactionSync()` called directly skip the gate the runtime's mailbox writes wait on, so another call's reply written while yours is open is lost to your rollback: open a transaction through `CloudflareCluster.DurableObjectSqlClient`'s `withTransaction`, which takes that gate, and await no timer or I/O in it, as the input gate it closes never lets them resume.
 * - The runtime owns the object's alarm, for scheduled tells, replays and `Entity.keepAlive`: `storage.setAlarm` or `deleteAlarm` replaces its alarm and loses what it scheduled, and the class's `alarm` runs the runtime's; schedule work with a persisted tell carrying `DeliverAt` instead.
 * - Tables whose names start with `cluster_` are the runtime's mailbox: write none, and read them only as its tests do.
 * - `abort` ends every call under way on the object and evicts it; the next call builds it again, and the runtime replays its unprocessed persisted messages.
 */
export class ObjectState extends Context.Service<
  ObjectState,
  Pick<DurableObjectState, "id" | "storage" | "waitUntil" | "abort">
>()("@gjermundgaraba/effect-actions-cloudflare/ActionCluster/ObjectState") {
  /** The state of the entity object running this, provided or recorded by its class, or a defect saying why there is none. */
  static readonly orDie: Effect.Effect<ObjectState["Service"]> = Effect.flatMap(
    Effect.serviceOption(ObjectState),
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        Effect.flatMap(storageHere, (storage) => {
          if (storage === undefined) {
            return Effect.die(
              new Error(
                "ActionCluster.ObjectState is read outside an entity's Durable Object: read it in an entity's build, services or handlers, or provide ObjectState in a test"
              )
            );
          }

          const state = stateOf(storage);

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
 * The function `CloudflareDurableObjects.setInitializer` takes: it builds `application(env)`, with
 * `HttpRouter.layer` beneath it, in a `ManagedRuntime` of its own on each call, and keeps the first
 * runtime to finish for the isolate, disposing a failed one and leaving a later one alive for the
 * isolate's life, since it may hold the isolate's entity registrations. Register it once, from the
 * Worker's module, and give the function `setInitializer` returns to `handler` and to
 * `ActionClusterEntity.make`. Guide: `docs/ActionCluster.md` in this package.
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
 * the function `CloudflareDurableObjects.setInitializer` returned for `initializer`. Guide:
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
