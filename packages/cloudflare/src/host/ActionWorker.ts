import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import * as CloudflareDurableObjects from "@effect/platform-cloudflare/CloudflareDurableObjects";
import type * as Action from "@gjermundgaraba/effect-actions/Action";
import type * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import type * as Event from "@gjermundgaraba/effect-actions/Event";
import type * as RequestPolicy from "@gjermundgaraba/effect-actions/RequestPolicy";
import { Context, Effect, Function, Layer } from "effect";
import type { Scope } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerResponse,
} from "effect/http";
import type { HttpServerRequest } from "effect/http";

import * as ActionCluster from "../cluster/ActionCluster.js";
import { hostClass } from "./host.js";
import type { Host } from "./host.js";
import { initializer } from "./initializer.js";

/** The four namespaces `make` reads by default, bound in `wrangler.jsonc` under these names. */
export interface Bindings {
  readonly CLUSTER_ENTITY: DurableObjectNamespace;
  readonly CLUSTER_WORKFLOW: DurableObjectNamespace;
  readonly CLUSTER_QUEUE: DurableObjectNamespace;
  readonly CLUSTER_SINGLETON: DurableObjectNamespace;
}

/** `ActionCluster.layer`'s options but its `entities`, which `make` takes from its own. */
export type ClusterOptions = Omit<CloudflareCluster.LayerOptions, "entities">;

/** What the cluster provides the application's layers. */
export type Cluster = Layer.Success<ReturnType<typeof ActionCluster.layer>>;

/**
 * A page's WebSocket to an entity's object, which the runtime keeps open while the object
 * hibernates: each call on it is forwarded into the object's own entity through `Entity.client`,
 * with the upgrade's headers `ActionEntity.forwardedHeaders` keeps under the message's own, its
 * own winning, and answered as the entity answers it. A page calls with
 * `ActionRpc.socketClient(binding, { url, watchMode: "poll" })`. Guide:
 * `docs/ActionWorker-sockets.md` in this package.
 *
 * **Gotchas**
 *
 * - A watch's poll that finds nothing new, on a page `notified`, is parked in the socket's attachment and asked again once `Stored.layerEvents`' change signal moved, read as `Stored.layerEvents` appends or `notify`s in the object, by a handler or by work it forked that outlived its call, and as each handler the object runs ends, whether a call, a tell or an alarm ran it: an entity whose events are not on `Stored.layerEvents`, and a check source not `notified`, have their polls answered at once, their watches polling at `nextPoll`, each poll a stub call.
 * - A post a socket watches, by a handler that sends no calls or tells, costs 1 + P stub calls, `invoke` each: the post, and one for each of the P polls parked on that object, sent as its first append or `notify` is made, a later change in the same post asking again only the polls that answered nothing; the page's client polls again `nextPoll` later, and that poll is parked with no call when nothing changed meanwhile and the last poll's call was under 30 seconds earlier, so a source whose `nextPoll` is 30 seconds or more costs one call a page each `nextPoll`; the signal is one for all the object's events, so any handler appending to any of its logs, or `notify`ing any of its sources, asks every parked poll again, whatever event it watches.
 * - A change a `notified` check source reads from an upstream, which no handler `notify`s, moves no signal at all, so a parked poll answers it only when its client sends it again, `ActionRpc.pollResentAfter` after it was sent: `notify` the source from a handler, or leave it not `notified`, to answer it at `nextPoll`.
 * - A source's subscription hook is held by the entity's activation until its `lease`, 5 minutes by default, after the last poll the host sent the entity, on a timer that keeps the object awake, so the object of a page watching a hooked source does not hibernate until the hook lapses: the host sends a page's poll at most 4 minutes 30 seconds after its last, or `nextPoll` after its last answer when that is longer, so a `lease` under 4 minutes 30 seconds may lapse while a poll is parked, and one not longer than its `nextPoll`, as the default is at a `nextPoll` of 5 minutes, may lapse after each answered page; a lapsed hook is set up again by the next poll the host sends the entity.
 * - Only the binding's actions and event types, or those `actions` lists, are forwarded: a call of a native rpc, which authenticates nothing, is answered `Unknown request tag`, and one of a streaming action, whose frames would hold the object awake, fails with a defect naming it.
 * - A call under way is interrupted, through Effect's own interrupt to the entity, when the page interrupts it, as `Effect.timeout` does, or its socket closes or fails; a frame the host cannot read is answered with Effect's `Defect`, which fails the page's calls under way on that socket, though each runs on in the entity to its end.
 * - A call under way when the object is evicted, by a deploy, a crash or `evictDurableObject`, is lost: the next instance closes that socket with 1012, and the page's client connects again and polls from its cursor; a message on a socket whose attachment the object cannot read, as after a deploy changing it, closes it with 1012 the same way, and a parked poll whose event type the deploy removed is answered `Unknown request tag`, as a call of it is, once the object next settles.
 * - The upgrade's headers, cookies included, are each call's credentials, and the host judges no `Origin`: give `make` a `policy`, which judges the upgrade before it reaches the object, or refuse a page of another site in `id`, which reads the request.
 * - The upgrade's headers, the calls under way and the parked polls, each with the headers its message sent, share the runtime's 16 KiB attachment: an upgrade past it is answered 431, and a call past it fails with a defect naming it.
 * - The runtime answers the page's pings itself, so an open page does not wake the object, and the host answers a page's close with its code and reason.
 */
export interface Socket {
  /**
   * The pathname of the upgrade, a `URLPattern` pathname such as `/rooms/:id/rpc`, whose group
   * `id`, percent-decoded, holds the entity id, as `ActionEntity.reaching` keys a call's decoded
   * input.
   *
   * **Gotchas**
   *
   * - A pattern naming no `id`, or a segment that does not decode, matches no request: it is answered by the routes, 404.
   * - A request at the path that is no WebSocket upgrade matches no socket: it is answered by the routes, or `fallback`.
   */
  readonly path: string;
  /** The entity id for the decoded `id` group the page sent in `request`, or `undefined` to answer the upgrade as one matching no socket, 404; by default, the decoded group. */
  readonly id?:
    | ((sent: string, request: Request) => string | undefined)
    | undefined;
  /**
   * The actions and event types of the entity's binding the socket serves: `AgentEvents`, a page
   * that only watches. Defaults to every action and event type of its binding.
   *
   * **Gotchas**
   *
   * - A call of one the socket does not serve, or a poll of one a deploy removed, is answered `Unknown request tag`, as Effect's server answers one: change `protocol.version` with the list, so a page built against the old one reloads instead.
   * - A contract the binding does not hold, or a streaming action, whose frames would hold the object awake, throws as `make` runs.
   */
  readonly actions?: ReadonlyArray<Action.Any | Event.Any> | undefined;
  /**
   * The version a page's upgrade names, `?protocol=<version>` in its URL, every other refused with
   * a close; without it, every upgrade is accepted.
   *
   * **Gotchas**
   *
   * - A socket the runtime kept across a deploy changing `version` is closed with `code` at its next message, or as the object next settles, its parked polls unanswered: the version its upgrade named is in its attachment.
   * - A socket accepted by a release whose attachment holds no version, or names another entity, is closed with 1012 at its next message, and its page's upgrade is then judged as any other.
   */
  readonly protocol?:
    | {
        /** The version served. */
        readonly version: string;
        /** The close code of a refusal, an integer from 4000 to 4999, which `ActionRpc.socketClient` stops at; another throws as `make` runs. */
        readonly code: number;
        /** The close reason, at most 123 bytes UTF-8 encoded; by default `This server speaks protocol <version>: reload the page`. A longer one throws as `make` runs. */
        readonly reason?: string | undefined;
      }
    | undefined;
}

/** One entity of the Worker: its declaration, the layer serving it, and its socket. */
export interface Entity<Env> {
  /** The entity, `ActionEntity.make`'s, registered with the cluster. */
  readonly entity: ActionEntity.Any &
    CloudflareCluster.LayerOptions["entities"][number];
  /** The layer serving it, `ActionEntity.layer(entity, ...)`, built in the isolate's one runtime over the cluster. */
  readonly layer: (env: Env) => Layer.Layer<never, unknown, Cluster>;
  /** A page's WebSocket to the entity's object; without it, its objects accept none. */
  readonly socket?: Socket | undefined;
}

/** `make`'s options. */
export interface Options<Env> {
  /** Each entity of the cluster, each named once. */
  readonly entities: ReadonlyArray<Entity<Env>>;
  /**
   * The Worker's HTTP routes, `ActionHttp.layer(binding, ActionEntity.reaching(entity))` and any of
   * its own, given `HttpServer.layerServices` and the cluster; without it, the Worker serves its
   * sockets and `fallback` alone.
   *
   * **Gotchas**
   *
   * - A service it outputs, such as a `Logger.layer` it merges with `Layer.provideMerge`, is in every request's context, and one it only `Layer.provide`s reaches the routes' build alone: merge what a request reads.
   */
  readonly routes?:
    | ((
        env: Env
      ) => Layer.Layer<
        never,
        unknown,
        | Cluster
        | HttpRouter.HttpRouter
        | Layer.Success<typeof HttpServer.layerServices>
      >)
    | undefined;
  /**
   * The Host and Origin policy every request is judged by first, built from the first request's
   * `env` and kept for the isolate: a request it refuses is answered 403, `Forbidden`, reaching no
   * socket, route or fallback, nor the initializer.
   */
  readonly policy?: ((env: Env) => RequestPolicy.Policy) | undefined;
  /**
   * The answer to a request that is no WebSocket upgrade and that no route matches, such as a
   * page's path; without it, the routes answer it 404.
   *
   * **Gotchas**
   *
   * - It runs once the application is built, as the routes do: a page the Worker answers waits for the isolate's first build.
   * - A route that matched and answered 404 is not a miss, and neither is an upgrade no socket matched: `fallback` answers neither.
   */
  readonly fallback?:
    | ((request: Request, env: Env) => Response | PromiseLike<Response>)
    | undefined;
  /**
   * The cluster's four namespaces and its other options, `ActionCluster.layer`'s but `entities`;
   * by default, `env`'s `Bindings`.
   *
   * **Gotchas**
   *
   * - Where `Env` binds the namespaces under other names than `Bindings`', `make` does not compile without it.
   */
  readonly cluster?: ((env: Env) => ClusterOptions) | undefined;
}

/** What `make` returns: the Worker module's exports, and the isolate's application. */
export interface Worker<Env> {
  /** The Worker's `fetch`, its module's default export as `{ fetch }`. */
  readonly fetch: (request: Request, env: Env) => Promise<Response>;
  /** The application's context, built once per isolate, for a Worker of its own that calls an entity's client itself. */
  readonly context: (
    env: Env
  ) => Promise<Context.Context<Cluster | HttpRouter.HttpRouter>>;
  /** The entity class to export as `ClusterEntity`. */
  readonly ClusterEntity: new (ctx: DurableObjectState, env: Env) => Host<Env>;
  /** Effect's workflow class, to export as `ClusterWorkflow`. */
  readonly ClusterWorkflow: typeof CloudflareDurableObjects.ClusterWorkflow;
  /** Effect's queue class, to export as `ClusterDurableQueue`. */
  readonly ClusterDurableQueue: typeof CloudflareDurableObjects.ClusterDurableQueue;
  /** Effect's singleton class, to export as `ClusterSingleton`. */
  readonly ClusterSingleton: typeof CloudflareDurableObjects.ClusterSingleton;
}

const fromBindings = (env: unknown): ClusterOptions => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const bound = env as Bindings;

  return {
    entityNamespace: bound.CLUSTER_ENTITY,
    workflowNamespace: bound.CLUSTER_WORKFLOW,
    queueNamespace: bound.CLUSTER_QUEUE,
    singletonNamespace: bound.CLUSTER_SINGLETON,
  };
};

const decoded = (segment: string | undefined) => {
  try {
    return segment === undefined ? undefined : decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

const isUpgrade = (request: Request) =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

const isRouteMiss = (error: unknown) =>
  HttpServerError.isHttpServerError(error) &&
  error.reason._tag === "RouteNotFound";

/**
 * The Worker: each entity of `entities` registered with the cluster and served by its `layer`,
 * `routes` over them, one runtime built per isolate for both, and the four Durable Object classes
 * to export, the entity class serving each entity's `socket`. Its `fetch` judges every request by
 * `policy` first, hands a WebSocket upgrade a socket's path matches to the entity's object,
 * without waiting on the runtime, and answers the rest with the routes, or with `fallback` where no
 * route matches. Call it once, from the Worker's module, exporting its classes under their names
 * and `{ fetch }` as the default. Guide: `docs/ActionWorker.md` in this package.
 *
 * **Gotchas**
 *
 * - It registers the isolate's Durable Object initializer, and a second call in one isolate throws `the Durable Object initializer is already set`: make one Worker, from the Worker's module.
 * - A build still pending after 15 seconds is abandoned and another started, and a stalled build that registered its entities refuses the replacement's, so the entities run in the stalled build's services, the routes in the kept one's, and a stall that then fails leaves the isolate serving no entity type: build nothing slow, such as a migration or a remote fetch, in `layer` or `routes`.
 * - A build that fails rejects the request waiting on it, and the next request builds again; one failing after another was kept answers the kept one.
 * - Without `policy`, a socket judges no `Origin`, and the upgrade's cookies are each call's credentials: give `policy`, or refuse a page of another site in the socket's `id`, which reads the request.
 * - The runtime owns each entity object's alarm: schedule work with the core's `ActionEntity.wakeAt`.
 */
export const make = <Env>(
  options: Options<Env> &
    (Env extends Bindings ? unknown : Required<Pick<Options<Env>, "cluster">>)
): Worker<Env> => {
  const { entities, routes, fallback } = options;

  const clusterOf: (env: Env) => ClusterOptions =
    options.cluster ?? fromBindings;

  const application = (env: Env) =>
    Layer.mergeAll(
      routes === undefined
        ? Layer.empty
        : routes(env).pipe(Layer.provide(HttpServer.layerServices)),
      ...entities.map(({ layer }) => layer(env))
    ).pipe(
      Layer.provideMerge(
        ActionCluster.layer({
          ...clusterOf(env),
          entities: entities.map(({ entity }) => entity),
        })
      )
    );

  const exposed = entities.flatMap(({ entity, socket }) =>
    socket === undefined ? [] : [{ ...socket, entity }]
  );

  const hostOf = hostClass(exposed);

  const context = CloudflareDurableObjects.setInitializer(
    initializer(application)
  );

  const ClusterEntity = hostOf(context);

  const sockets = exposed.map(({ entity, path, id = Function.identity }) => ({
    entity,
    id,
    pattern: new URLPattern({ pathname: path }),
  }));

  const objectOf = (env: Env, request: Request) => {
    for (const { entity, id, pattern } of sockets) {
      const sent = decoded(pattern.exec(request.url)?.pathname.groups["id"]);
      const entityId = sent === undefined ? undefined : id(sent, request);

      if (entityId !== undefined) {
        return clusterOf(env).entityNamespace.getByName(
          CloudflareCluster.encodeName(entity.type, entityId)
        );
      }
    }

    return undefined;
  };

  const serve = async (request: Request, env: Env) => {
    const built = await context(env);
    const router = Context.get(built, HttpRouter.HttpRouter).asHttpEffect();

    const answered =
      fallback === undefined || isUpgrade(request)
        ? router
        : Effect.catchIf(router, isRouteMiss, () =>
            Effect.map(
              Effect.promise(async () => await fallback(request, env)),
              HttpServerResponse.fromWeb
            )
          );

    return await HttpEffect.toWebHandlerWith<
      HttpRouter.HttpRouter,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >(built)(answered)(request);
  };

  let policy: RequestPolicy.Policy | undefined;

  return {
    fetch: async (request, env) => {
      policy ??= options.policy?.(env);

      if (policy !== undefined && !policy.allows(request)) {
        return new Response("Forbidden", { status: 403 });
      }

      const object = isUpgrade(request) ? objectOf(env, request) : undefined;

      return object === undefined
        ? await serve(request, env)
        : await object.fetch(request);
    },
    context,
    ClusterEntity,
    ClusterWorkflow: CloudflareDurableObjects.ClusterWorkflow,
    ClusterDurableQueue: CloudflareDurableObjects.ClusterDurableQueue,
    ClusterSingleton: CloudflareDurableObjects.ClusterSingleton,
  };
};
