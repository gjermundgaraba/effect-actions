import { DurableObject } from "cloudflare:workers";
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect";
import {
  FetchHttpClient,
  HttpEffect,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  type HttpClient,
  type HttpServerRequest,
} from "effect/http";
import type { RpcMessage, RpcServer } from "effect/rpc";
import { Calls, layerStub, type StubRequest } from "./calls.js";
import { Sockets } from "./sockets.js";
import { State } from "./state.js";
import { Feed } from "./feed.js";

export { Calls, layerStub, type StubRequest } from "./calls.js";

export { layerWebSocket, Sockets, type LayerWebSocketOptions } from "./sockets.js";

export { State } from "./state.js";

export {
  Feed,
  type EndOptions,
  type PublishOptions,
  type SubscribeOptions,
  type Subscriber,
} from "./feed.js";

export { client, layerStubClient, type Client, type Stub } from "./stub.js";

type ServedPerRequest = Scope.Scope | HttpServerRequest.HttpServerRequest;

type Allowed<A, S> =
  | State
  | Feed
  | Sockets
  | S
  | HttpRouter.HttpRouter
  | Layer.Success<typeof HttpServer.layerServices>
  | HttpRouter.Request<"Requires", ServedPerRequest | A | S>
  | HttpRouter.Request<"GlobalRequires", ServedPerRequest | A | S>
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>;

// Why: the signatures consumers call write these unions out, since a diagnostic prints an
// alias by its name, which tells no one what the option may require.
type ServicesRequire = State | Feed;

type RunRequires<S> = S | State | Feed | Scope.Scope;

type CallsRequire<S> = RpcServer.Protocol | S | State | Feed;

// Why: each option's own types, checked by the signatures that take it, are dropped below
// them: a Layer's outputs to `never` and its errors to `unknown`, its requirements kept.
type ErasedOptions<S> = Options<
  S,
  unknown,
  ServicesRequire,
  never,
  unknown,
  never,
  unknown,
  RunRequires<S>,
  never,
  unknown,
  CallsRequire<S>
>;

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
  CA = never,
  CE = never,
  CR = never,
> {
  /**
   * The object's startup services, such as a store over `State`'s `storage.sql`: built once per
   * instance, before the routes, again after every eviction, and never finalized. The routes,
   * every request, the alarm and `run` share that one build, and an implementation the services
   * build, such as an in-process `Action.client`'s, is the one the routes serve. They may
   * require `State` and `Feed` alone, so a store over the object's storage, what the object is,
   * such as its name, or an adapter publishing over its feed, is a Layer requiring them.
   *
   * **Gotchas**
   *
   * - A service only the routes need may be provided to them instead, but the alarm and `run` see only these: one they read too belongs here.
   * - A module-level Layer reading `env` from `cloudflare:workers` as the module evaluates finds it unset: read it as the Layer builds or serves, or give `make` a function of the instance's `env`.
   */
  readonly services?: Layer.Layer<S, SE, SR> | undefined;
  /**
   * What `fetch` serves: routes, as `HttpRouter.toWebHandler` serves them, such as
   * `ActionRpc.layer` over `layerWebSocket` and `ActionHttp.layer`. Built after the services,
   * again after every eviction, and never finalized. They may require `State`, `Feed`, `Sockets` and
   * the services; a request-time requirement must be provided by their middleware or
   * authentication, or be one of the services or a service they provide themselves. Without
   * them, `fetch` answers 404, and there are no socket handlers, as no protocol accepts a socket.
   *
   * **Gotchas**
   *
   * - Router middleware and `HttpRouter.provideRequest` around the routes run for a socket's upgrade request alone: a service only they provide is missing from every call over the socket, which dies with `Internal server error`; list an `RpcMiddleware` in `ActionRpc.layer`'s `middleware`, or make it a startup service.
   * - `toWebHandler` reads no `HttpServerRequest.MaxBodySize`: the platform limits request bodies.
   */
  readonly routes?: Layer.Layer<A, E, R> | undefined;
  /**
   * What the object serves over its stub, on `effectActionsRpc`: an rpc server, such as
   * `RpcServer.layer(group)` with its handlers, or `ActionRpc.layer`, given `layerStub` as its
   * protocol. Built after the services, beside the routes, again after every eviction, and never
   * finalized. It may require the protocol, `State`, `Feed` and the services; every call's own
   * requirement must be provided by its middleware or be one of those. Without it, a call over
   * the stub rejects at once.
   *
   * **Gotchas**
   *
   * - The calls serve one group on the one protocol `make` and `handlers` give them: serve several groups as one, `group.merge(other)`, as a second `layerStub()` fails the build.
   * - A plain group suits an object's own API, which only its Worker and other objects call; an `ActionRpc.layer` suits actions served on other surfaces too, called with `ActionRpc.client` over `layerStubClient`.
   */
  readonly calls?: Layer.Layer<CA, CE, CR> | undefined;
  /**
   * What the object's `alarm` runs, scheduled with `State`'s `storage.setAlarm`, given the
   * runtime's `retryCount` and `isRetry`. It may require the services, `State`, `Feed` and a `Scope`,
   * closed when it ends. It runs through `run`, once the services and routes are built, given
   * the `AlarmInvocationInfo` or `undefined` when the object's `alarm` is called with none.
   *
   * **Gotchas**
   *
   * - A failure rejects `alarm`, which the runtime retries with backoff, up to six times.
   * - The object has one alarm: setting it again replaces it, so a store setting it for its next expiry sets the earliest.
   * - Without it, the class `make` returns has no `alarm` handler, and workerd refuses `storage.setAlarm`, at that call.
   */
  readonly alarm?:
    | ((info: AlarmInvocationInfo | undefined) => Effect.Effect<void, AE, AR>)
    | undefined;
  /**
   * Whether to leave out the request logger `HttpRouter.toWebHandler` adds by default, which logs
   * every request the routes serve, a socket's upgrade included: Effect's default, kept.
   */
  readonly disableLogger?: boolean | undefined;
}

type HandlerOf<K extends keyof DurableObject<Cloudflare.Env>> = NonNullable<
  DurableObject<Cloudflare.Env>[K]
>;

/**
 * The socket handlers of an object serving `routes`, each taking the runtime's own arguments:
 * `handlers` returns them, and the class `make` returns defines them, only when the options have
 * `routes`, since without them no protocol accepts a socket.
 */
export interface SocketHandlers {
  /**
   * Hands the message to the protocol whose socket it is, through `Sockets`, and resolves for a
   * socket no protocol accepted.
   */
  webSocketMessage(...args: Parameters<HandlerOf<"webSocketMessage">>): Promise<void>;
  /** Ends the socket's protocol client, and resolves for a socket no protocol accepted. */
  webSocketClose(...args: Parameters<HandlerOf<"webSocketClose">>): Promise<void>;
  /** Ends the socket's protocol client, and resolves for a socket no protocol accepted. */
  webSocketError(...args: Parameters<HandlerOf<"webSocketError">>): Promise<void>;
}

/**
 * The handlers `handlers` returns, each taking the runtime's own arguments, so a Durable Object
 * class delegates those it serves this way and writes the others itself: the socket handlers
 * only with `routes`. Each awaits the object's build, started by the first of them called, and
 * rejects with its failure.
 */
export interface Handlers<S = never> extends SocketHandlers {
  /** Serves the routes, or answers 404 when there are none. */
  fetch(...args: Parameters<HandlerOf<"fetch">>): Promise<Response>;
  /**
   * Answers one call over the object's stub, the messages `layerStubClient` sends, with its
   * responses, as values, through `Calls`, once every request it carries has its exit, or
   * rejects at once without `calls`. Workers RPC calls it by this name, the package's, so it
   * does not collide with the class's own methods.
   */
  effectActionsRpc(request: StubRequest): Promise<ReadonlyArray<RpcMessage.FromServerEncoded>>;
  /** Runs the `alarm` option through `run`, or nothing when there is none. */
  alarm(...args: Parameters<HandlerOf<"alarm">>): Promise<void>;
  /**
   * Runs `effect` in the object, with the services the instance built, `State`, `Feed` and a `Scope`,
   * closed when it ends, once the services and routes are built: what the alarm runs through,
   * and what the object's own methods run their Effects with, such as a method a Worker calls
   * over the object's stub. A Layer the effect provides itself, or an `Action.client` it
   * acquires, is built for that call alone: give what calls share as `services`.
   */
  run<A, E>(effect: Effect.Effect<A, E, S | State | Feed | Scope.Scope>): Promise<A>;
}

const refuse = () =>
  Promise.reject(
    new Error(
      "This Durable Object serves no rpcs over its stub: give handlers or make a calls Layer",
    ),
  );

const handlersKey: unique symbol = Symbol("effect-actions-cloudflare/ActionDurableObject/handlers");

const handlersOf = <S>(
  ctx: DurableObjectState,
  options: Omit<ErasedOptions<S>, "routes"> & { readonly routes?: Layer.Any | undefined },
) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Omitted services: `S` is then inferred as `never`, which the empty Layer provides.
  const services = (options.services ?? Layer.empty) as Layer.Layer<S, unknown, ServicesRequire>;

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased routes: the signature checked every requirement against `Allowed<A, S>`, the built services supply `S`, merged in, and the router gives each request the services the routes provide, `A`, and its request markers, as `HttpRouter.toWebHandler`'s types say; only those subtractions, which a generic `A` and `S` keep unresolved, are erased.
  const routes = options.routes as
    | Layer.Layer<
        never,
        unknown,
        | State
        | Feed
        | Sockets
        | HttpRouter.HttpRouter
        | Layer.Success<typeof HttpServer.layerServices>
      >
    | undefined;

  const calls = options.calls;

  const state = Layer.succeed(State, ctx);

  const build = Effect.gen(function* () {
    // Why: an implementation of the core is shared through the memo map of the graph it is
    // built in, so services, calls and routes build in this one map: an implementation the
    // services build is the one the calls and routes serve.
    const memoMap = yield* Layer.makeMemoMap;
    const scope = yield* Scope.make();

    const built = Effect.gen(function* () {
      // Why: built once, here, into the context the calls, the routes and every `run` are
      // given; their scope is closed only when the build fails, so nothing is finalized while
      // the instance lives, and a failed build leaves no fiber of its own running.
      const context = yield* Layer.buildWithMemoMap(
        services.pipe(Layer.provideMerge(Feed.layer), Layer.provideMerge(state)),
        memoMap,
        scope,
      );

      const given = Layer.succeedContext(context);

      // Why: `Calls` and `Sockets` are built with what registers with them, the calls and the
      // routes, so an object without either has no registry no protocol could fill.
      const call =
        calls === undefined
          ? refuse
          : yield* Effect.map(
              Layer.buildWithMemoMap(
                calls.pipe(
                  Layer.provide(layerStub()),
                  Layer.provideMerge(Calls.layer),
                  Layer.provide(given),
                ),
                memoMap,
                scope,
              ),
              (served) => (request: StubRequest) =>
                Effect.runPromise(Context.get(served, Calls).call(request)),
            );

      if (routes === undefined) {
        return {
          context,
          call,
          sockets: undefined,
          serve: () => Promise.resolve(new Response(null, { status: 404 })),
        };
      }

      const sockets = yield* Layer.buildWithMemoMap(
        Sockets.layer.pipe(Layer.provide(given)),
        memoMap,
        scope,
      );

      const routed = yield* Layer.buildWithMemoMap(
        routes.pipe(
          Layer.provideMerge(
            Layer.succeedContext<State | Feed | Sockets>(Context.merge(context, sockets)),
          ),
          Layer.provide(HttpServer.layerServices),
          Layer.provideMerge(HttpRouter.layer),
        ),
        memoMap,
        scope,
      );

      // Why: the handler is made here, as `HttpRouter.toWebHandler` makes it once its Layer is
      // built, so a defect making it, such as global middleware throwing, fails this build,
      // which closes its scope and is made again by the next event, where `toWebHandler` would
      // hold the failed handler for every event of the instance.
      const serve = yield* Effect.sync(() =>
        HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(
          routed,
        )(
          Context.get(routed, HttpRouter.HttpRouter).asHttpEffect(),
          options.disableLogger === true ? undefined : HttpMiddleware.logger,
        ),
      );

      return { context, call, sockets: Context.get(sockets, Sockets), serve };
    });

    return yield* built.pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
  });

  let building: Promise<Effect.Success<typeof build>> | undefined;

  // Why: built on the first event, rather than in the constructor under
  // `blockConcurrencyWhile`, so no event waits on a window the runtime limits to 30 seconds, and
  // events arriving meanwhile await the one build. A failed build's Layer would stay failed in a
  // memo map whose scope stays open, and its protocols registered with its `Calls` and
  // `Sockets`, so a failure closes its scope and drops the promise holding its memo map and
  // dispatchers, and the next event builds from nothing.
  const built = () => {
    if (building === undefined) {
      // Why: a build failing before its first async step has failed when `runPromiseExit`
      // returns, so a reset inside the build would run before the promise is held, and hold the
      // failure for good; a `then` callback runs only after.
      building = Effect.runPromiseExit(build).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value;

        building = undefined;

        return Promise.reject(Cause.squash(exit.cause));
      });
    }

    return building;
  };

  const run = async <A, E>(effect: Effect.Effect<A, E, RunRequires<S>>): Promise<A> => {
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
    const { sockets } = await built();

    if (sockets !== undefined) await Effect.runPromise(event(sockets));
  };

  const onAlarm = options.alarm;

  return {
    common: {
      fetch: async (request) => (await built()).serve(request),
      effectActionsRpc:
        calls === undefined ? refuse : async (request) => (await built()).call(request),
      alarm: (info) => run(onAlarm?.(info) ?? Effect.void),
      run,
    } satisfies Omit<Handlers<S>, keyof SocketHandlers>,
    sockets: {
      webSocketMessage: (socket, message) =>
        dispatch((sockets) => sockets.message(socket, message)),
      webSocketClose: (socket, code, reason) =>
        dispatch((sockets) => sockets.close(socket, code, reason)),
      webSocketError: (socket) => dispatch((sockets) => sockets.error(socket)),
    } satisfies SocketHandlers,
  };
};

/** What `handlers` returns given `RT`, its `routes`: the socket handlers only with routes. */
type HandlersOf<S, RT> = [RT] extends [Layer.Any]
  ? Handlers<S>
  : Omit<Handlers<S>, keyof SocketHandlers>;

/** What `make` returns given `RT`, its `routes`: the socket handlers only with routes. */
type InstanceOf<S, Env, RT> = [RT] extends [Layer.Any]
  ? SocketHandlers & Instance<S, Env>
  : Instance<S, Env>;

/**
 * The object's lifecycle, for a Durable Object class that cannot extend the one `make` returns:
 * given its `ctx`, the handlers that build `services`, then `calls`, with `Calls` and
 * `layerStub`, and `routes`, with `Sockets`, once per instance, on the first event, with `State`
 * and `Feed` provided, and share that one build across every event, which awaits it. `fetch` serves the
 * routes, the socket handlers dispatch through `Sockets`, `effectActionsRpc` through `Calls`,
 * `alarm` runs `alarm` and `run` runs an Effect in the object. Delegate the handlers the class
 * serves this way, as methods: `effectActionsRpc(request: StubRequest)` returning the
 * handlers' own.
 *
 * **Gotchas**
 *
 * - An instance lasts until the runtime evicts it, and the next event builds everything again on a new one: nothing the services, calls or routes build is finalized, and in-memory state is lost, so keep state in storage.
 * - A build that fails rejects every event awaiting it, each with the same failure, and is dropped with all it built: the next event builds again.
 * - Nothing holds the object while it builds, so a build has no time limit of its own.
 * - Without `routes`, `fetch` answers 404 and it returns no socket handlers: a class accepting its own sockets defines its own; without `calls`, `effectActionsRpc` rejects at once, naming the option.
 * - A socket the class accepts itself, with `State`'s `acceptWebSocket`, carries no protocol's tag: the socket handlers resolve for it, so the class answers the sockets carrying its own tag in `webSocketMessage` and delegates the rest.
 * - The class defines `alarm` only when it has one: workerd refuses `storage.setAlarm` on a class without an `alarm` method.
 *
 * Guide: `docs/ActionDurableObject-own-class.md` in this package.
 */
export const handlers = <
  S = never,
  SE = never,
  SR extends State | Feed = never,
  A = never,
  E = never,
  R extends Allowed<A, S> = never,
  AE = never,
  AR extends S | State | Feed | Scope.Scope = never,
  CA = never,
  CE = never,
  CR extends RpcServer.Protocol | S | State | Feed = never,
  RT = undefined,
>(
  ctx: DurableObjectState,
  options: Options<S, SE, SR, A, E, R, AE, AR, CA, CE, CR> & { readonly routes?: RT },
): HandlersOf<S, RT> => {
  const { common, sockets } = handlersOf(ctx, options);

  // Why: without routes no protocol accepts a socket, so the socket handlers would only wake a
  // hibernating object for a socket the class accepted itself, and a close handler that does
  // not reciprocate leaves the client a 1006 under a `compatibility_date` before `2026-04-07`:
  // a class accepting its own sockets defines its own.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Options-dependent handlers: the socket handlers are left out exactly when there are no routes, as `HandlersOf` states.
  return (options.routes === undefined ? common : { ...common, ...sockets }) as HandlersOf<S, RT>;
};

/**
 * An instance of a class `make` returns, with the handlers it defines, each taking the
 * runtime's own arguments, so a class extending it overrides them as Cloudflare declares them,
 * its `env` the one its `services` function takes. Its `alarm` and socket handlers are
 * Cloudflare's own, optional: a class made without `alarm` has none, and one made with `routes`
 * has the `SocketHandlers` in its type too.
 */
export interface Instance<S = never, Env = Cloudflare.Env> extends DurableObject<Env> {
  fetch(...args: Parameters<HandlerOf<"fetch">>): Promise<Response>;
  /** `Handlers`' `effectActionsRpc`: what `layerStubClient` and `client` call. */
  effectActionsRpc(request: StubRequest): ReturnType<Handlers["effectActionsRpc"]>;
  /**
   * `Handlers`' `run`, for the methods of a class extending this one. A Durable Object's public
   * methods are callable over its stub, this one too, but it takes an Effect, which no stub can
   * send: a caller over the stub gets a rejection, nothing more.
   */
  run<A, E>(effect: Effect.Effect<A, E, S | State | Feed | Scope.Scope>): Promise<A>;
}

/**
 * `make` with `services`, a function of the instance's `env`, whose parameter's type is the
 * class's `env`: the class `make` returns otherwise.
 *
 * Guide: `docs/ActionDurableObject.md` in this package.
 */
export function make<
  S,
  SE,
  SR extends State | Feed,
  A = never,
  E = never,
  R extends Allowed<A, S> = never,
  AE = never,
  AR extends S | State | Feed | Scope.Scope = never,
  CA = never,
  CE = never,
  CR extends RpcServer.Protocol | S | State | Feed = never,
  Env = Cloudflare.Env,
  RT = undefined,
>(
  options: Omit<Options<S, SE, SR, A, E, R, AE, AR, CA, CE, CR>, "services"> & {
    /**
     * The object's startup services, as `handlers`' `services`, returned by a function of the
     * instance's `env`, `this.env`, called as each instance is constructed: a service reads a
     * binding or a variable from the `env` it is given, whose type, the function's parameter's,
     * is the class's `env`.
     */
    readonly services: (env: Env) => Layer.Layer<S, SE, SR>;
    readonly routes?: RT;
  },
): new (ctx: DurableObjectState, env: Env) => InstanceOf<S, Env, RT>;
// Why: a `services` function of `env` has its parameter inferred, which fixes the type
// parameters a default gives before the function's return gives `S`, so its signature has none
// for the services. The other stays last, since TypeScript reports an argument matching neither
// against the last alone.
/**
 * A Durable Object class delegating every handler, and `run`, to `handlers` over its own `ctx`,
 * with the services `services` returns for its `env`: it serves `routes` on `fetch`, the
 * sockets their protocols accept on `webSocketMessage`, `webSocketClose` and `webSocketError`,
 * and `calls` on `effectActionsRpc`, the method a caller's `layerStubClient` or `client` calls
 * over the stub, and runs `alarm`. Export it, or a class extending it, under the name the
 * Wrangler configuration binds; a class extending it overrides only the handlers it has reason
 * to write, and reaches `make`'s through `super`.
 *
 * **Gotchas**
 *
 * - Made with `routes`, it has the `SocketHandlers`, which resolve for a socket no protocol accepted, such as one a class extending it accepts itself: an override answers its own sockets and calls `super` for the rest. Made without, it has none, and a class accepting its own sockets defines its own.
 * - The `services` function's parameter type is the class's `env`, so an application's own `Env` needs no augmenting of `Cloudflare.Env`; services reading no `env` are `() => layer`, and a class without one has `Cloudflare.Env`.
 * - Made without `alarm`, the class has no `alarm` handler: workerd refuses `storage.setAlarm` on it with `Your Durable Object class must have an alarm() handler`, and celld 0.6.2 accepts the call and drops the alarm when it is due.
 * - Made with one, `alarm` is optional in `Instance`'s type, as Cloudflare declares it: an override reaches it with `await super.alarm?.(info)`.
 *
 * Guide: `docs/ActionDurableObject.md` in this package; in an application:
 * `examples/chat-rooms/`.
 */
export function make<
  S = never,
  SE = never,
  SR extends State | Feed = never,
  A = never,
  E = never,
  R extends Allowed<A, S> = never,
  AE = never,
  AR extends S | State | Feed | Scope.Scope = never,
  CA = never,
  CE = never,
  CR extends RpcServer.Protocol | S | State | Feed = never,
  RT = undefined,
>(
  options: Omit<Options<S, SE, SR, A, E, R, AE, AR, CA, CE, CR>, "services"> & {
    readonly services?: ((env: Cloudflare.Env) => Layer.Layer<S, SE, SR>) | undefined;
    readonly routes?: RT;
  },
): new (ctx: DurableObjectState, env: Cloudflare.Env) => InstanceOf<S, Cloudflare.Env, RT>;
export function make<S>(
  options: Omit<ErasedOptions<S>, "services" | "routes"> & {
    readonly routes?: Layer.Any | undefined;
    readonly services?:
      | ((env: Cloudflare.Env) => Layer.Layer<S, unknown, ServicesRequire>)
      | undefined;
  },
): new (ctx: DurableObjectState, env: Cloudflare.Env) => Instance<S> {
  class ActionDurableObject extends DurableObject<Cloudflare.Env> {
    // Why: the handlers are an instance's, reached by the subclasses below, which add the socket
    // handlers and the alarm only when the options have them; a private field is not visible to
    // a subclass, and a property a string names would be callable over the stub.
    readonly [handlersKey]: Handlers<S>;

    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      super(ctx, env);

      const { common, sockets } = handlersOf(this.ctx, {
        ...options,
        services: options.services?.(this.env),
      });

      this[handlersKey] = { ...common, ...sockets };
    }

    override fetch(...args: Parameters<HandlerOf<"fetch">>) {
      return this[handlersKey].fetch(...args);
    }

    effectActionsRpc(request: StubRequest) {
      return this[handlersKey].effectActionsRpc(request);
    }

    run<A, E>(effect: Effect.Effect<A, E, RunRequires<S>>) {
      return this[handlersKey].run(effect);
    }
  }

  const Served =
    options.routes === undefined
      ? ActionDurableObject
      : class extends ActionDurableObject {
          override webSocketMessage(...args: Parameters<HandlerOf<"webSocketMessage">>) {
            return this[handlersKey].webSocketMessage(...args);
          }

          override webSocketClose(...args: Parameters<HandlerOf<"webSocketClose">>) {
            return this[handlersKey].webSocketClose(...args);
          }

          override webSocketError(...args: Parameters<HandlerOf<"webSocketError">>) {
            return this[handlersKey].webSocketError(...args);
          }
        };

  // Why: workerd refuses `storage.setAlarm` on an instance without an `alarm` handler, at the call
  // that sets it, so a class made without one has none, where a handler rejecting every
  // alarm would fail later, retried. Made with one, `alarm` is a method of a class extending the
  // base, so a class extending that overrides it and calls it through `super`.
  const Made =
    options.alarm === undefined
      ? Served
      : class extends Served {
          override alarm(info?: AlarmInvocationInfo) {
            return this[handlersKey].alarm(info);
          }
        };

  return Made;
}

/**
 * An `HttpClient` whose requests go to `fetcher`, a Durable Object stub or a service binding,
 * in place of the network: what `ActionHttp.client`, `ActionRpc.client` over
 * `RpcClient.layerProtocolHttp` and `ActionMcp.client` call an object's routes with, or a
 * Worker's.
 *
 * **Gotchas**
 *
 * - A request's URL needs a host, which the fetcher ignores, such as `https://object/api`: a relative URL fails before it is sent.
 * - Nothing authenticates the request on its way: forward the caller's credential, with the client's `transformClient`, as for any remote surface.
 * - To pass a page's request on to an object, forward the `Request` itself with the stub's `fetch`: its upgrade goes with it, which this client does not send.
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
