import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import type * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import {
  Context,
  Effect,
  Function,
  Layer,
  ManagedRuntime,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { ClusterSchema, Sharding } from "effect/cluster";
import { Headers, HttpEffect, HttpRouter } from "effect/http";
import type { HttpServerRequest } from "effect/http";

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
 */
export const layer = (
  options: CloudflareCluster.LayerOptions
): Layer.Layer<Layer.Success<ReturnType<typeof CloudflareCluster.layer>>> =>
  Layer.effect(Sharding.Sharding)(
    Effect.map(Effect.service(Sharding.Sharding), (sharding) =>
      Sharding.Sharding.of({
        ...sharding,
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
 * The function `CloudflareDurableObjects.setInitializer` takes: it builds `application(env)`, with
 * `HttpRouter.layer` beneath it, in a `ManagedRuntime` of its own on each call, and keeps the first
 * runtime to finish for the isolate, disposing a failed or later one. Register it once, from the
 * Worker's module, and give the function `setInitializer` returns to `handler` and to
 * `ActionClusterEntity.make`. Guide: `docs/ActionCluster.md` in this package.
 *
 * **Gotchas**
 *
 * - A build still pending after 15 seconds is abandoned and the initializer called again, and a stalled build that registered its entities refuses the replacement's, leaving the kept runtime serving no entity type: build nothing slow, such as a migration or a remote fetch, above `ActionCluster.layer`.
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

    if (kept !== runtime) {
      await runtime.dispose();
    }

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
          /** The pathname matched, whose named group `id` holds the entity id as the page sent it. */
          readonly path: RegExp;
          /** The entity id for the `id` group the page sent in `request`, or `undefined` to answer the request as one matching no route; by default, the group as sent. */
          readonly id?:
            | ((sent: string, request: Request) => string | undefined)
            | undefined;
        }>;
      }
    | undefined;
}

const objectOf = <Env>(
  { entityNamespace, routes }: NonNullable<HandlerOptions<Env>["sockets"]>,
  env: Env,
  request: Request
) => {
  const { pathname } = new URL(request.url);

  for (const { entity, path, id = Function.identity } of routes) {
    const sent = path.exec(pathname)?.groups?.["id"];
    const entityId = sent === undefined ? undefined : id(sent, request);

    if (entityId !== undefined) {
      return entityNamespace(env).getByName(
        CloudflareCluster.encodeName(entity.type, entityId)
      );
    }
  }

  return undefined;
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
 * - A path with the `g` or `y` flag keeps its `lastIndex` between requests, so it misses every other request: give one with neither.
 */
export const handler = <Env>(
  initialize: (env: Env) => PromiseLike<Context.Context<HttpRouter.HttpRouter>>,
  options: HandlerOptions<Env> = {}
) => {
  const { sockets } = options;

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
      const object =
        sockets === undefined ? undefined : objectOf(sockets, env, request);

      return object === undefined
        ? await serve(request, env)
        : await object.fetch(request);
    },
  };
};
