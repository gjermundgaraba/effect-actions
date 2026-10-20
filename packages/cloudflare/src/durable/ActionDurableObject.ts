import { DurableObject } from "cloudflare:workers";
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  type HttpClient,
  type HttpServerRequest,
} from "effect/http";
import { Sockets } from "./sockets.js";
import { State } from "./state.js";

export { layerWebSocket, Sockets, type LayerWebSocketOptions } from "./sockets.js";

export { State } from "./state.js";

type ServedPerRequest = Scope.Scope | HttpServerRequest.HttpServerRequest;

type Allowed<A, S> =
  | State
  | Sockets
  | S
  | HttpRouter.HttpRouter
  | Layer.Success<typeof HttpServer.layerServices>
  | HttpRouter.Request<"Requires", ServedPerRequest | A | S>
  | HttpRouter.Request<"GlobalRequires", ServedPerRequest | A | S>
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>;

/** `handlers`' and `make`'s options. */
export interface Options<
  S = never,
  SE = never,
  SR = never,
  A = never,
  E = never,
  R = never,
  AE = never,
  AR = never,
> {
  /**
   * The object's startup services, such as a store over `State`'s `storage.sql`: built once per
   * instance, before the routes, again after every eviction, and never finalized. The routes,
   * every request, the alarm and `run` share that one build, and an implementation the services
   * build, such as an in-process `Action.client`'s, is the one the routes serve. They may
   * require `State` alone.
   */
  readonly services?: Layer.Layer<S, SE, SR> | undefined;
  /**
   * What `fetch` serves: routes, as `HttpRouter.toWebHandler` serves them, such as
   * `ActionRpc.layer` over `layerWebSocket` and `ActionHttp.layer`. Built after the services,
   * again after every eviction, and never finalized. They may require `State`, `Sockets` and
   * the services; a request-time requirement must be provided by their middleware or
   * authentication, or be one of the services or a service they provide themselves. Without
   * them, `fetch` answers 404.
   */
  readonly routes?: Layer.Layer<A, E, R> | undefined;
  /**
   * What the object's `alarm` runs, scheduled with `State`'s `storage.setAlarm`, given the
   * runtime's `retryCount` and `isRetry`. It may require the services, `State` and a `Scope`,
   * closed when it ends. It runs through `run`. A failure rejects `alarm`, which Cloudflare
   * retries.
   */
  readonly alarm?:
    | ((info: AlarmInvocationInfo | undefined) => Effect.Effect<void, AE, AR>)
    | undefined;
  /** Whether to leave out the request logger `HttpRouter.toWebHandler` adds by default. */
  readonly disableLogger?: boolean | undefined;
}

type HandlerOf<K extends keyof DurableObject<Cloudflare.Env>> = NonNullable<
  DurableObject<Cloudflare.Env>[K]
>;

/**
 * The handlers `handlers` returns, each taking the runtime's own arguments, so a Durable Object
 * class delegates those it serves this way and writes the others itself. Each awaits the
 * object's build, started by the first of them called, and rejects with its failure.
 */
export interface Handlers<S = never> {
  /** Serves the routes, or answers 404 when there are none. */
  fetch(...args: Parameters<HandlerOf<"fetch">>): Promise<Response>;
  /**
   * Hands the message to the protocol whose socket it is, through `Sockets`, and resolves for a
   * socket no protocol accepted.
   */
  webSocketMessage(...args: Parameters<HandlerOf<"webSocketMessage">>): Promise<void>;
  /** Ends the socket's protocol client, and resolves for a socket no protocol accepted. */
  webSocketClose(...args: Parameters<HandlerOf<"webSocketClose">>): Promise<void>;
  /** Ends the socket's protocol client, and resolves for a socket no protocol accepted. */
  webSocketError(...args: Parameters<HandlerOf<"webSocketError">>): Promise<void>;
  /** Runs the `alarm` option through `run`, or nothing when there is none. */
  alarm(...args: Parameters<HandlerOf<"alarm">>): Promise<void>;
  /**
   * Runs `effect` in the object, with the services the instance built, `State` and a `Scope`,
   * closed when it ends, once the services and routes are built: what the alarm runs through,
   * and what the object's own methods run their Effects with, such as a method a Worker calls
   * over the object's stub. A Layer the effect provides itself, or an `Action.client` it
   * acquires, is built for that call alone: give what calls share as `services`.
   */
  run<A, E>(effect: Effect.Effect<A, E, S | State | Scope.Scope>): Promise<A>;
}

const notFound: (request: Request) => Promise<Response> = () =>
  Promise.resolve(new Response(null, { status: 404 }));

/**
 * The object's lifecycle, for a Durable Object class of your own: given its `ctx`, the
 * handlers that build `services`, then `routes`, once per instance, on the first event, with
 * `State` and `Sockets` provided, and share that one build across every event. `fetch` serves
 * the routes, the socket handlers dispatch through `Sockets`, `alarm` runs `alarm` and `run`
 * runs an Effect in the object. A build that fails rejects the events awaiting it, and the next
 * event builds everything again. The runtime evicts an idle instance and constructs a new one
 * for the next event, so nothing the services or routes build is finalized, and in-memory state
 * lasts no longer than an instance.
 *
 * Guide: `docs/ActionDurableObject-own-class.md` in this package.
 */
export const handlers = <
  S = never,
  SE = never,
  SR extends State = never,
  A = never,
  E = never,
  R extends Allowed<A, S> = never,
  AE = never,
  AR extends S | State | Scope.Scope = never,
>(
  ctx: DurableObjectState,
  options: Options<S, SE, SR, A, E, R, AE, AR>,
): Handlers<S> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Omitted services: `S` is then inferred as `never`, which the empty Layer provides.
  const services = (options.services ?? Layer.empty) as Layer.Layer<S, SE, State>;

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased routes: the signature checked every requirement against `Allowed<A, S>`, the built services supply `S`, merged in, and the handler gives each request the services the routes provide, `A`, as `HttpRouter.toWebHandler`'s types say; only those subtractions, which a generic `A` and `S` keep unresolved, are erased.
  const routes = options.routes as Layer.Layer<never, E, Allowed<never, never>> | undefined;

  const state = Layer.succeed(State, ctx);

  const build = Effect.gen(function* () {
    // Why: an implementation of the core is shared through the memo map of the graph it is
    // built in, so services and routes build in this one map: an implementation the services
    // build is the one the routes serve, and `Sockets` the one their protocols register with.
    const memoMap = yield* Layer.makeMemoMap;
    const scope = yield* Scope.make();

    const built = Effect.gen(function* () {
      // Why: built once, here, into the context the routes and every `run` are given; their
      // scope is closed only when the build fails, so nothing is finalized while the instance
      // lives, and a failed build leaves no fiber of its own running.
      const context = yield* Layer.buildWithMemoMap(
        Layer.mergeAll(services, Sockets.layer).pipe(Layer.provideMerge(state)),
        memoMap,
        scope,
      );

      if (routes === undefined) return { context, serve: notFound };

      const routesBuilt = yield* Deferred.make<void, unknown>();

      const web = HttpRouter.toWebHandler(
        routes.pipe(
          Layer.provideMerge(Layer.succeedContext<State | Sockets>(context)),
          Layer.tap(() => Deferred.succeed(routesBuilt, undefined)),
          Layer.tapCause((cause) => Deferred.failCause(routesBuilt, cause)),
          Layer.provide(HttpServer.layerServices),
        ),
        { memoMap, disableLogger: options.disableLogger },
      );

      yield* Scope.addFinalizer(scope, Effect.promise(web.dispose));
      yield* Deferred.await(routesBuilt);

      return { context, serve: web.handler };
    });

    return yield* built.pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
  });

  let building: Promise<Effect.Success<typeof build>> | undefined;

  // Why: built on the first event, rather than in the constructor under
  // `blockConcurrencyWhile`, so no event waits on a window the runtime limits to 30 seconds, and
  // events arriving meanwhile await the one build. A failed build's Layer would stay failed in a
  // memo map whose scope stays open, and its protocols registered with its `Sockets`, so a
  // failure closes its scope and drops the promise holding its memo map and `Sockets`, and the
  // next event builds from nothing.
  const built = () =>
    (building ??= Effect.runPromise(
      Effect.onError(build, () =>
        Effect.sync(() => {
          building = undefined;
        }),
      ),
    ));

  const run = async <A, E>(effect: Effect.Effect<A, E, S | State | Scope.Scope>): Promise<A> => {
    const { context } = await built();

    // Why: the services' context carries the instance's memo map, which `run` gave every effect
    // before, so a Layer it provided itself was shared when the services or routes had built
    // that very value, and rebuilt per call otherwise, without a word. A map of its own makes
    // the rule one: the services are shared, and what a `run` provides is per call.
    return Effect.runPromise(
      Effect.scopedWith((scope) =>
        Effect.provideContext(
          effect,
          context.pipe(
            Context.add(Scope.Scope, scope),
            Context.add(Layer.CurrentMemoMap, Layer.makeMemoMapUnsafe()),
          ),
        ),
      ),
    );
  };

  const dispatch = async (event: (sockets: Sockets["Service"]) => Effect.Effect<boolean>) => {
    const { context } = await built();

    await Effect.runPromise(event(Context.get(context, Sockets)));
  };

  const onAlarm:
    | ((info: AlarmInvocationInfo | undefined) => Effect.Effect<void, AE, S | State | Scope.Scope>)
    | undefined = options.alarm;

  return {
    fetch: async (request) => (await built()).serve(request),
    webSocketMessage: (socket, message) => dispatch((sockets) => sockets.message(socket, message)),
    webSocketClose: (socket) => dispatch((sockets) => sockets.close(socket)),
    webSocketError: (socket) => dispatch((sockets) => sockets.error(socket)),
    alarm: (info) => run(onAlarm?.(info) ?? Effect.void),
    run,
  };
};

/**
 * An instance of a class `make` returns, with the handlers it defines, each taking the
 * runtime's own arguments, so a class extending it overrides them as Cloudflare declares them.
 * Its `alarm` is Cloudflare's own, optional: a class made without one has none.
 */
export interface Instance<S = never> extends DurableObject<Cloudflare.Env> {
  fetch(...args: Parameters<HandlerOf<"fetch">>): Promise<Response>;
  webSocketMessage(...args: Parameters<HandlerOf<"webSocketMessage">>): Promise<void>;
  webSocketClose(...args: Parameters<HandlerOf<"webSocketClose">>): Promise<void>;
  webSocketError(...args: Parameters<HandlerOf<"webSocketError">>): Promise<void>;
  /**
   * `Handlers`' `run`, for the methods of a class extending this one. A Durable Object's public
   * methods are callable over its stub, this one too, but it takes an Effect, which no stub can
   * send: a caller over the stub gets a rejection, nothing more.
   */
  run<A, E>(effect: Effect.Effect<A, E, S | State | Scope.Scope>): Promise<A>;
}

/**
 * A Durable Object class delegating every handler, and `run`, to `handlers` over its own `ctx`:
 * it serves `routes` on `fetch`, and the sockets their protocols accept on `webSocketMessage`,
 * `webSocketClose` and `webSocketError`, and runs `alarm`. A socket no protocol accepted, such
 * as one a class extending it accepts itself, is left to that class: the three handlers resolve
 * for it, so an override answers its own sockets and calls `super` for the rest. Export it, or a
 * class extending it, under the name the Wrangler configuration binds. Made without `alarm`,
 * the class has no alarm handler: workerd refuses `storage.setAlarm` on it, and celld 0.6.2
 * accepts the call and consumes the alarm silently.
 *
 * Guide: `docs/ActionDurableObject.md` in this package; in an application:
 * `examples/chat-rooms/`.
 */
export const make = <
  S = never,
  SE = never,
  SR extends State = never,
  A = never,
  E = never,
  R extends Allowed<A, S> = never,
  AE = never,
  AR extends S | State | Scope.Scope = never,
>(
  options: Options<S, SE, SR, A, E, R, AE, AR>,
): new (ctx: DurableObjectState, env: Cloudflare.Env) => Instance<S> => {
  const onAlarm:
    | ((info: AlarmInvocationInfo | undefined) => Effect.Effect<void, AE, S | State | Scope.Scope>)
    | undefined = options.alarm;

  class ActionDurableObject extends DurableObject<Cloudflare.Env> {
    readonly #object = handlers(this.ctx, options);

    override fetch(...args: Parameters<HandlerOf<"fetch">>) {
      return this.#object.fetch(...args);
    }

    override webSocketMessage(...args: Parameters<HandlerOf<"webSocketMessage">>) {
      return this.#object.webSocketMessage(...args);
    }

    override webSocketClose(...args: Parameters<HandlerOf<"webSocketClose">>) {
      return this.#object.webSocketClose(...args);
    }

    override webSocketError(...args: Parameters<HandlerOf<"webSocketError">>) {
      return this.#object.webSocketError(...args);
    }

    run<A, E>(effect: Effect.Effect<A, E, S | State | Scope.Scope>) {
      return this.#object.run(effect);
    }
  }

  // Why: workerd refuses `storage.setAlarm` on an instance without an `alarm` handler, at the call
  // that sets it, so a class made without one has none, where a handler rejecting every
  // alarm would fail later, retried. Made with one, `alarm` is a method of a class extending the
  // base, so a class extending that overrides it and calls it through `super`.
  return onAlarm === undefined
    ? ActionDurableObject
    : class extends ActionDurableObject {
        override alarm(info?: AlarmInvocationInfo) {
          return this.run(onAlarm(info));
        }
      };
};

/**
 * An `HttpClient` whose requests go to `fetcher`, a Durable Object stub or a service binding,
 * in place of the network: what `ActionHttp.client`, `ActionRpc.client` over
 * `RpcClient.layerProtocolHttp` and `ActionMcp.client` call it with. A request's URL needs a
 * host, which the fetcher ignores, such as `https://object/api`. Nothing authenticates the
 * request on its way: forward the caller's credential, as for any remote surface.
 *
 * Guide: `docs/ActionDurableObject.md` in this package.
 */
export const layerHttpClient = (
  fetcher: Pick<Fetcher, "fetch">,
): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch)((input, init) => fetcher.fetch(input, init)),
    ),
  );
