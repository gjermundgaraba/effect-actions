import { DurableObject } from "cloudflare:workers";
import { Cause, Context, Effect, Exit, Layer, Scheduler, Scope } from "effect";
import {
  HttpEffect,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  type HttpServerRequest,
} from "effect/http";
import { type RpcMessage, RpcServer } from "effect/rpc";
import { Alarm, alarmOf, applicationOwner, makeSchedule } from "./alarm.js";
import { makeStubProtocol, type StubRequest } from "./calls.js";
import { Sockets } from "./sockets.js";
import { State } from "./state.js";

export { Alarm } from "./alarm.js";

export type { StubRequest } from "./calls.js";

export {
  layerWebSocket,
  refuseUpgrade,
  type LayerWebSocketOptions,
  type Sockets,
} from "./sockets.js";

export { name, State } from "./state.js";

export { client, layerStubClient, type Client, type Stub } from "./stub.js";

export { layerHttpClient } from "./fetcher.js";

type ServedPerRequest = Scope.Scope | HttpServerRequest.HttpServerRequest;

// Why: each request is served in the context the routes are built in, so a handler reads the
// object's own services as the routes' Layers do.
type ObjectServices = State | Alarm | Sockets;

type Allowed<A, S> =
  | ObjectServices
  | S
  | HttpRouter.HttpRouter
  | Layer.Success<typeof HttpServer.layerServices>
  | HttpRouter.Request<"Requires", ServedPerRequest | ObjectServices | A | S>
  | HttpRouter.Request<"GlobalRequires", ServedPerRequest | ObjectServices | A | S>
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>;

// Why: the signatures consumers call write these unions out, since a diagnostic prints an
// alias by its name, which tells no one what the option may require.
type ServicesRequire = State | Alarm;

type RunRequires<S> = S | State | Alarm | Scope.Scope;

type CallsRequire<S> = RpcServer.Protocol | S | State | Alarm;

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
   * require `State` and `Alarm` alone, so a store over the object's storage, what the object
   * is, such as its name, or a store scheduling its expiries, is a Layer requiring them.
   *
   * **Gotchas**
   *
   * - A service only the routes need may be provided to them instead, but the alarm and `run` see only these: one they read too belongs here.
   * - A module-level Layer reading `env` from `cloudflare:workers` as the module evaluates finds it unset: read it as the Layer builds or serves, or give `make` a function of the instance's `env`.
   * - They build under the instance's gate, which holds every event of the object until they end: one calling another object as it builds, rather than only making its client, waits on that object's gate, and two objects calling each other as they build wait on each other until the runtime resets both, 30 seconds on. Call other objects from a handler or the alarm.
   */
  readonly services?: Layer.Layer<S, SE, SR> | undefined;
  /**
   * What `fetch` serves: routes, as `HttpRouter.toWebHandler` serves them, such as
   * `ActionRpc.layer` over `layerWebSocket` and `ActionHttp.layer`. Built after the services,
   * again after every eviction, and never finalized. They may require `State`, `Alarm`,
   * `Sockets` and the services, as Layers and as
   * handlers; any other request-time requirement must be provided by their middleware or
   * authentication, or be a service they provide themselves. Without them, `fetch` answers 404, and
   * no protocol accepts a socket.
   *
   * **Gotchas**
   *
   * - Router middleware and `HttpRouter.provideRequest` around the routes run for a socket's upgrade request alone: a service only they provide is missing from every call over the socket, which dies with `Internal server error`; list an `RpcMiddleware` in `ActionRpc.layer`'s `middleware`, or make it a startup service.
   * - `toWebHandler` reads no `HttpServerRequest.MaxBodySize`: the platform limits request bodies.
   */
  readonly routes?: Layer.Layer<A, E, R> | undefined;
  /**
   * What the object serves over its stub, on `effectActionsRpc`: an rpc server, such as
   * `RpcServer.layer(group)` with its handlers, or `ActionRpc.layer`, given the stub's protocol,
   * over which each call of `effectActionsRpc` is one call, its messages in and its responses out,
   * as values Workers RPC's structured clone copies, each schema's plain form
   * (`Schema.toCodecIso`), never a JSON string. Built after the services, beside the routes,
   * again after every eviction, and never finalized. It may require the protocol, `State`,
   * `Alarm` and the services; every call's own requirement must be provided by
   * its middleware or be one of those. Without it, a call over the stub rejects once the object
   * is built, naming the option.
   *
   * **Gotchas**
   *
   * - The calls serve one group on the one protocol `make` and `handlers` give them: serve several groups as one, `group.merge(other)`.
   * - Calls running no rpc server on the protocol, such as a group's handlers given without `RpcServer.layer(group)`, fail the object's build, naming it.
   * - A `Date`, bytes, `undefined` and an `Error` defect cross as themselves; an `Option`, an exit and a tagged error as their tagged objects, a `Map` and a `Set` as arrays.
   * - A schema with no JSON form, such as `Schema.instanceOf(Date)`, works over the stub, not over `layerWebSocket`, which speaks JSON; an `ActionRpc` binding's values cross as JSON over either.
   * - A value the clone refuses, such as a class instance in a `Schema.Unknown`, or a defect that is a class instance other than an `Error`, fails the whole call with workerd's `DataCloneError`, whatever its exit.
   * - Unary: a call answers once every request it carries has its exit, so an rpc that streams is answered with a defect at its first chunk, naming it: stream over `layerWebSocket`.
   * - An `ActionRpc.layer` here fails its build when the binding serves a streaming action or an event type: list the others in its `actions`.
   * - A defect Effect's server sends as fatal to the whole client, such as a handler's die, is answered as the exit of each request of the call still without one, a die: the call fails with that defect alone, and the client's next call is answered.
   * - In a raw `effectActionsRpc` call batching several requests, a handler's die before another request's answer gives that request two exits, the defect first, which Effect's client takes, then its own; `layerStubClient` sends one request per call and never meets it.
   * - Nothing authenticates a call: a stub is reachable only through a binding, so the caller is the Worker or another object of the deployment, and one acting for a principal forwards it in a header, with `RpcClient.withHeaders`, read by an `RpcMiddleware` or an `ActionRpc` binding's authentication, or in the payload.
   * - A plain group suits an object's own API, which only its Worker and other objects call; an `ActionRpc.layer` suits actions served on other surfaces too, called with `ActionRpc.client` over `layerStubClient`.
   */
  readonly calls?: Layer.Layer<CA, CE, CR> | undefined;
  /**
   * What runs at the time `Alarm.set` gave, given its `scheduledTime` and `retryCount`, 0 at that
   * time and counting each failed or cut-off run as it is retried. It may require the services, `State`, `Alarm`
   * and a `Scope`, closed when it ends. It runs through `run`, once the services
   * and routes are built.
   *
   * **Gotchas**
   *
   * - A failure is logged and retried 2 seconds later, doubling, six times, as the runtime retries a plain object's alarm, then hourly until a run succeeds, never dropped: the object's `alarm` resolves, so the runtime records no failure.
   * - A run an eviction, a deploy or a crash cuts off runs again at its retry's time, counted in `retryCount` as a failure, so a run may repeat: make what it sends idempotent.
   * - It runs once per `Alarm.set`: setting a time again replaces it, so a store setting it for its next expiry sets the earliest, and the option sets its next one itself.
   */
  readonly alarm?: ((info: AlarmInvocationInfo) => Effect.Effect<void, AE, AR>) | undefined;
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
 * The handlers `handlers` returns and the class `make` returns defines, each taking the runtime's
 * own arguments, so a Durable Object class delegates those it serves this way and writes the
 * others itself. Each awaits the object's build, started by the first of them called, and
 * rejects with its failure.
 */
export interface Handlers<S = never> {
  /** Serves the routes, or answers 404 when there are none. */
  fetch(...args: Parameters<HandlerOf<"fetch">>): Promise<Response>;
  /**
   * Hands the message to the protocol whose socket it is, and resolves for a socket no protocol
   * accepted.
   */
  webSocketMessage(...args: Parameters<HandlerOf<"webSocketMessage">>): Promise<void>;
  /**
   * Completes the closing handshake of any socket, replying with the client's code and reason,
   * and ends the socket's protocol client, if a protocol accepted it.
   */
  webSocketClose(...args: Parameters<HandlerOf<"webSocketClose">>): Promise<void>;
  /** Ends the socket's protocol client, and resolves for a socket no protocol accepted. */
  webSocketError(...args: Parameters<HandlerOf<"webSocketError">>): Promise<void>;
  /**
   * Answers one call over the object's stub, the messages `layerStubClient` sends, with its
   * responses, as values, through the `calls` option's server, once every request it carries
   * has its exit, or rejects without `calls`. Workers RPC calls it by this name, the package's,
   * so it does not collide with the class's own methods.
   */
  effectActionsRpc(request: StubRequest): Promise<ReadonlyArray<RpcMessage.FromServerEncoded>>;
  /**
   * Runs, through `run`, each time the object's schedule holds that has come: the `alarm`
   * option's, which `Alarm.set` gave.
   */
  alarm(...args: Parameters<HandlerOf<"alarm">>): Promise<void>;
  /**
   * Runs `effect` in the object, with the services the instance built, `State`, `Alarm`
   * and a `Scope`, closed when it ends, once the services and routes are built:
   * what the alarm runs through, and what the object's own methods run their Effects with, such
   * as a method a Worker calls over the object's stub. A Layer the effect provides itself, or an `Action.client` it
   * acquires, is built for that call alone: give what calls share as `services`.
   *
   * **Gotchas**
   *
   * - A Durable Object's public methods are callable over its stub, the `run` of a class `make` returns too, but it takes an Effect, which no stub can send: a caller over the stub gets a rejection, nothing more.
   */
  run<A, E>(effect: Effect.Effect<A, E, S | State | Alarm | Scope.Scope>): Promise<A>;
}

// Why: Effect's default scheduler starts a forked fiber, such as each call an rpc server
// handles, and yields a long one, on a timer, and a timer lets the runtime deliver the object's
// next event: two calls reading then writing storage, with nothing between, each lost a write
// to the other. Effect's own advice on Workers is its microtask scheduler, under which an
// object's Effects interleave only where its plain JavaScript methods would. Reversing it brings
// the lost writes back; its cost is that CPU-heavy work no longer lets other events in.
const scheduler = new Scheduler.MixedScheduler("sync");

const handlersOf = <S>(
  ctx: DurableObjectState,
  options: Omit<ErasedOptions<S>, "routes"> & { readonly routes?: Layer.Any | undefined },
): Handlers<S> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Omitted services: `S` is then inferred as `never`, which the empty Layer provides.
  const services = (options.services ?? Layer.empty) as Layer.Layer<S, unknown, ServicesRequire>;

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased routes: the signature checked every requirement against `Allowed<A, S>`, the built services supply `S`, merged in, and the router gives each request the services the routes provide, `A`, and its request markers, as `HttpRouter.toWebHandler`'s types say; only those subtractions, which a generic `A` and `S` keep unresolved, are erased.
  const routes = options.routes as
    | Layer.Layer<
        never,
        unknown,
        | State
        | Alarm
        | Sockets
        | HttpRouter.HttpRouter
        | Layer.Success<typeof HttpServer.layerServices>
      >
    | undefined;

  const calls = options.calls;

  const state = Layer.succeed(State, ctx);

  const schedule = makeSchedule(ctx);

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
        services.pipe(
          Layer.provideMerge(Layer.succeed(Alarm)(alarmOf(schedule))),
          Layer.provideMerge(state),
          Layer.provideMerge(Layer.succeed(Scheduler.Scheduler)(scheduler)),
        ),
        memoMap,
        scope,
      );

      const given = Layer.succeedContext(context);

      yield* schedule.restore;

      const call =
        calls === undefined
          ? () =>
              Promise.reject(
                new Error(
                  "This Durable Object serves no rpcs over its stub: give handlers or make a calls Layer",
                ),
              )
          : yield* Effect.gen(function* () {
              const stub = yield* Effect.provideContext(makeStubProtocol, context);

              yield* Layer.buildWithMemoMap(
                calls.pipe(
                  Layer.provide(Layer.succeed(RpcServer.Protocol)(stub.protocol)),
                  Layer.provide(given),
                ),
                memoMap,
                scope,
              );

              yield* stub.served;

              return (request: StubRequest) => Effect.runPromise(stub.serve(request));
            });

      const sockets = yield* Layer.buildWithMemoMap(
        Sockets.layer.pipe(Layer.provide(given)),
        memoMap,
        scope,
      );

      const serve =
        routes === undefined
          ? () => Promise.resolve(new Response(null, { status: 404 }))
          : yield* Effect.gen(function* () {
              const routed = yield* Layer.buildWithMemoMap(
                routes.pipe(
                  Layer.provideMerge(
                    Layer.succeedContext<ObjectServices>(Context.merge(context, sockets)),
                  ),
                  Layer.provide(HttpServer.layerServices),
                  Layer.provideMerge(HttpRouter.layer),
                ),
                memoMap,
                scope,
              );

              // Why: the handler is made here, as `HttpRouter.toWebHandler` makes it once its
              // Layer is built, so a defect making it, such as global middleware throwing, fails
              // this build, which closes its scope and is made again by the next event, where
              // `toWebHandler` would hold the failed handler for every event of the instance.
              return yield* Effect.sync(() =>
                HttpEffect.toWebHandlerWith<
                  never,
                  HttpServerRequest.HttpServerRequest | Scope.Scope
                >(routed)(
                  Context.get(routed, HttpRouter.HttpRouter).asHttpEffect(),
                  options.disableLogger === true ? undefined : HttpMiddleware.logger,
                ),
              );
            });

      return { context, call, sockets: Context.get(sockets, Sockets), serve };
    });

    return yield* built.pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
  });

  type Built = Effect.Success<typeof build>;

  interface Waiting {
    readonly use: (built: Built) => Promise<void>;
    readonly fail: (cause: Cause.Cause<Effect.Error<typeof build>>) => void;
  }

  let instance: Built | undefined;
  let building = false;
  const waiting: Array<Waiting> = [];

  // Why: built as the instance is constructed, under `blockConcurrencyWhile`, so the runtime holds
  // every event, the first included, until the build ends, and each then finds `instance` set
  // and starts at once, as on a built instance. An event arriving while a build runs, the one
  // building again after a failure or one the runtime let in that same turn, waits in line and
  // runs once the gate opens, one after another: resumed together from one promise, calls
  // reading then writing storage each read before any wrote, a write lost. They run outside the
  // gate, as one calling another object that calls this one back would wait under it on its own
  // callback until the runtime reset the object. A failed build's Layer would stay failed in a
  // memo map whose scope stays open, and its protocols registered with its `Sockets`, so a
  // failure closes its scope and drops it, rejects the events in line with it, and the next
  // event builds from nothing; the gate's callback resolves either way, as a rejection under it
  // would reset the object.
  const start = () => {
    building = true;

    void ctx
      .blockConcurrencyWhile(async () => {
        const exit = await Effect.runPromiseExit(build, { scheduler });

        building = false;

        if (Exit.isFailure(exit)) {
          for (const next of waiting.splice(0)) next.fail(exit.cause);

          return undefined;
        }

        instance = exit.value;

        return instance;
      })
      .then(async (built) => {
        if (built === undefined) return;

        for (let next = waiting.shift(); next !== undefined; next = waiting.shift()) {
          await next.use(built);
        }
      });
  };

  start();

  const withBuilt = <A>(use: (built: Built) => A | Promise<A>): Promise<A> => {
    const held = instance;

    if (held !== undefined) return new Promise<A>((resolve) => resolve(use(held)));

    return new Promise<A>((resolve, reject) => {
      waiting.push({
        use: (built) => {
          const used = new Promise<A>((done) => done(use(built)));

          resolve(used);

          return used.then(
            () => undefined,
            () => undefined,
          );
        },
        fail: (cause) => reject(Cause.squash(cause)),
      });

      if (!building) start();
    });
  };

  // Why: the services' context carries the instance's memo map, which `run` gave every effect
  // before, so a Layer it provided itself was shared when the services or routes had built that
  // very value, and rebuilt per call otherwise, without a word. A map of its own makes the rule
  // one: the services are shared, and what a `run` or a task provides is per call.
  const provided = <A, E>({ context }: Built, effect: Effect.Effect<A, E, RunRequires<S>>) =>
    Effect.scopedWith((scope) =>
      Effect.provideContext(
        effect,
        context.pipe(
          Context.add(Scope.Scope, scope),
          Context.add(Layer.CurrentMemoMap, Layer.makeMemoMapUnsafe()),
        ),
      ),
    );

  // Why: the services' context carries the object's scheduler, which `provided` gives `run`, as
  // the calls' and the protocols' own context gives each call and socket event.
  const run = <A, E>(effect: Effect.Effect<A, E, RunRequires<S>>): Promise<A> =>
    withBuilt((built) => Effect.runPromise(provided(built, effect)));

  const dispatch = (event: (sockets: Sockets["Service"]) => Effect.Effect<boolean>) =>
    withBuilt(({ sockets }) => Effect.runPromise(Effect.asVoid(event(sockets))));

  return {
    fetch: (request) => withBuilt(({ serve }) => serve(request)),
    webSocketMessage: (socket, message) => dispatch((sockets) => sockets.message(socket, message)),
    webSocketClose: (socket, code, reason) =>
      dispatch((sockets) => sockets.close(socket, code, reason)),
    webSocketError: (socket) => dispatch((sockets) => sockets.error(socket)),
    effectActionsRpc: (request) => withBuilt(({ call }) => call(request)),
    alarm: () =>
      run(
        schedule.runDue({
          [applicationOwner]: (info) => options.alarm?.(info) ?? Effect.void,
        }),
      ),
    run,
  };
};

/**
 * The object's lifecycle, for a Durable Object class that cannot extend the one `make` returns:
 * given its `ctx`, the handlers that build `services`, then `calls`, with the stub's protocol,
 * and `routes`, with `Sockets`, once per instance, as it is constructed, with `State` and `Alarm`
 * provided, and share that one build across every event, which awaits it. `fetch` serves the
 * routes, the socket handlers dispatch through `Sockets`, `effectActionsRpc` through the calls'
 * server, `alarm` runs the times `Alarm` keeps and `run` runs an Effect in the object.
 * Delegate the handlers the class serves this way, as methods:
 * `effectActionsRpc(request: StubRequest)` returning the handlers' own.
 *
 * **Gotchas**
 *
 * - An instance lasts until the runtime evicts it, and the next event builds everything again on a new one: nothing the services, calls or routes build is finalized, and in-memory state is lost, so keep state in storage.
 * - A build that fails is dropped with all it built, and the events waiting on it are rejected with its failure: the next event builds again, under the same gate.
 * - The events arriving while a build runs, such as the one building again after a failure, run once it ends, one after another, each to its end before the next: a slow one holds those after it.
 * - An instance builds as it is constructed, under `blockConcurrencyWhile`, so the runtime holds every event, the first included, until the build ends, then delivers them one by one, as to a built instance: a build longer than 30 seconds resets the object.
 * - Every Effect of the object runs under Effect's microtask scheduler, `new Scheduler.MixedScheduler("sync")`, where its default's timers would let the next event in between any two steps: CPU-heavy work holds every other event until it ends.
 * - Calls still interleave where a plain method's would: while one waits on I/O, another object or a timer, such as `Effect.sleep`, the next event runs, so serialize a read and the write that depends on it with a `Semaphore`, or make both one synchronous `storage.kv` or `storage.sql` step.
 * - Without `routes`, `fetch` answers 404; without `calls`, `effectActionsRpc` rejects once the object is built, naming the option.
 * - A socket the class accepts itself, with `State`'s `acceptWebSocket`, carries no protocol's tag: the socket handlers resolve for it, `webSocketClose` once it has replied to the client's close, so the class answers the sockets carrying its own tag in `webSocketMessage` and delegates the rest.
 * - Delegate `alarm` too: the object's one alarm is the package's, and workerd refuses `storage.setAlarm`, which `Alarm.set` calls, on a class without an `alarm` method, where celld 0.6.2 accepts it and drops the alarm when it is due.
 */
export const handlers = <
  S = never,
  SE = never,
  SR extends State | Alarm = never,
  A = never,
  E = never,
  R extends Allowed<A, S> = never,
  AE = never,
  AR extends S | State | Alarm | Scope.Scope = never,
  CA = never,
  CE = never,
  CR extends RpcServer.Protocol | S | State | Alarm = never,
>(
  ctx: DurableObjectState,
  options: Options<S, SE, SR, A, E, R, AE, AR, CA, CE, CR>,
): Handlers<S> => handlersOf(ctx, options);

/**
 * An instance of a class `make` returns: a Durable Object with the handlers it defines, each
 * taking the runtime's own arguments, so a class extending it overrides them as `Handlers`
 * declares them, returning a promise, and reaches `make`'s through `super`, its `env` the one its
 * `services` function takes.
 */
// Why: `Handlers` comes first, so `super.alarm(info)` and the other handlers resolve to the
// delegated signatures, which always exist, rather than Cloudflare's optional ones.
export type Instance<S = never, Env = Cloudflare.Env> = Handlers<S> & DurableObject<Env>;

/**
 * `make` with `services`, a function of the instance's `env`, whose parameter's type is the
 * class's `env`: the class `make` returns otherwise.
 */
export function make<
  S,
  SE,
  SR extends State | Alarm,
  A = never,
  E = never,
  R extends Allowed<A, S> = never,
  AE = never,
  AR extends S | State | Alarm | Scope.Scope = never,
  CA = never,
  CE = never,
  CR extends RpcServer.Protocol | S | State | Alarm = never,
  Env = Cloudflare.Env,
>(
  options: Omit<Options<S, SE, SR, A, E, R, AE, AR, CA, CE, CR>, "services"> & {
    /**
     * The object's startup services, as `handlers`' `services`, returned by a function of the
     * instance's `env`, `this.env`, called as each instance is constructed: a service reads a
     * binding or a variable from the `env` it is given, whose type, the function's parameter's,
     * is the class's `env`.
     */
    readonly services: (env: Env) => Layer.Layer<S, SE, SR>;
  },
): new (ctx: DurableObjectState, env: Env) => Instance<S, Env>;
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
 * - Its socket handlers resolve for a socket no protocol accepted, such as one a class extending it accepts itself, `webSocketClose` once it has replied to the client's close: an override answers its own sockets and calls `super` for the rest.
 * - The `services` function's parameter type is the class's `env`, so an application's own `Env` needs no augmenting of `Cloudflare.Env`; services reading no `env` are `() => layer`, and a class without one has `Cloudflare.Env`.
 * - It always has `alarm`, the package's, which runs the `alarm` option at the time `Alarm.set` gave: an override reaches it with `await super.alarm(info)`, and one that does not call it runs none of the times `Alarm` keeps.
 */
export function make<
  S = never,
  SE = never,
  SR extends State | Alarm = never,
  A = never,
  E = never,
  R extends Allowed<A, S> = never,
  AE = never,
  AR extends S | State | Alarm | Scope.Scope = never,
  CA = never,
  CE = never,
  CR extends RpcServer.Protocol | S | State | Alarm = never,
>(
  options: Omit<Options<S, SE, SR, A, E, R, AE, AR, CA, CE, CR>, "services"> & {
    readonly services?: ((env: Cloudflare.Env) => Layer.Layer<S, SE, SR>) | undefined;
  },
): new (ctx: DurableObjectState, env: Cloudflare.Env) => Instance<S>;
export function make<S>(
  options: Omit<ErasedOptions<S>, "services" | "routes"> & {
    readonly routes?: Layer.Any | undefined;
    readonly services?:
      | ((env: Cloudflare.Env) => Layer.Layer<S, unknown, ServicesRequire>)
      | undefined;
  },
): new (ctx: DurableObjectState, env: Cloudflare.Env) => Instance<S> {
  return class ActionDurableObject extends DurableObject<Cloudflare.Env> {
    readonly #handlers: Handlers<S>;

    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      super(ctx, env);

      this.#handlers = handlersOf(this.ctx, {
        ...options,
        services: options.services?.(this.env),
      });
    }

    override fetch(...args: Parameters<HandlerOf<"fetch">>) {
      return this.#handlers.fetch(...args);
    }

    override webSocketMessage(...args: Parameters<HandlerOf<"webSocketMessage">>) {
      return this.#handlers.webSocketMessage(...args);
    }

    override webSocketClose(...args: Parameters<HandlerOf<"webSocketClose">>) {
      return this.#handlers.webSocketClose(...args);
    }

    override webSocketError(...args: Parameters<HandlerOf<"webSocketError">>) {
      return this.#handlers.webSocketError(...args);
    }

    effectActionsRpc(request: StubRequest) {
      return this.#handlers.effectActionsRpc(request);
    }

    // Why: always defined, as the object's one alarm is the package's: workerd refuses
    // `storage.setAlarm`, which `Alarm.set` calls, on a class without an `alarm` handler.
    override alarm(info?: AlarmInvocationInfo) {
      return this.#handlers.alarm(info);
    }

    run<A, E>(effect: Effect.Effect<A, E, RunRequires<S>>) {
      return this.#handlers.run(effect);
    }
  };
}
