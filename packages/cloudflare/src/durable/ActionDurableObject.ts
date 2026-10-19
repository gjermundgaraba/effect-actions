import { DurableObject } from "cloudflare:workers";
import { Context, Deferred, Effect, Layer, type Scope } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  type HttpClient,
  type HttpServerRequest,
} from "effect/http";
import { RpcServer } from "effect/rpc";
import { makeProtocol, type Receiver, Receivers } from "./sockets.js";

/**
 * The object's own `DurableObjectState`, `ctx`: its storage, its id, its alarm and its sockets.
 * A startup service of `make`'s routes and alarm, one per instance, so a store over
 * `storage.sql` is a Layer requiring it.
 */
export class State extends Context.Service<State, DurableObjectState>()(
  "effect-actions-cloudflare/ActionDurableObject/State",
) {}

type ServedPerRequest = Scope.Scope | HttpServerRequest.HttpServerRequest;

type Allowed<A> =
  | State
  | HttpRouter.HttpRouter
  | Layer.Success<typeof HttpServer.layerServices>
  | HttpRouter.Request<"Requires", ServedPerRequest | A>
  | HttpRouter.Request<"GlobalRequires", ServedPerRequest | A>
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>;

/** `make`'s options. */
export interface Options<A = never, E = never, R = never, AE = never, AR = never> {
  /**
   * What `fetch` serves: routes, as `HttpRouter.toWebHandler` serves them, such as
   * `ActionRpc.layer` over `layerWebSocket` and `ActionHttp.layer`. Built when the instance is,
   * again after every eviction, and never finalized. They may require `State`; a request-time
   * requirement must be provided by their middleware or authentication, or be a service they
   * provide themselves, such as one merged in with `Layer.provideMerge`.
   */
  readonly routes: Layer.Layer<A, E, R>;
  /**
   * What the object's `alarm` runs, scheduled with `State`'s `storage.setAlarm`, given the
   * runtime's `retryCount` and `isRetry`. It may require `State` and a `Scope`, closed when it
   * ends. It runs once the routes are built, and a layer it and the routes both provide is built
   * once per instance. A failure rejects `alarm`, which Cloudflare retries.
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
 * An instance of a class `make` returns, with the handlers it defines, each taking the
 * runtime's own arguments, so a class extending it overrides them as Cloudflare declares them.
 */
export interface Instance extends DurableObject<Cloudflare.Env> {
  fetch(request: Request): Promise<Response>;
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(...args: Parameters<HandlerOf<"webSocketClose">>): Promise<void>;
  webSocketError(...args: Parameters<HandlerOf<"webSocketError">>): Promise<void>;
  alarm?(info?: AlarmInvocationInfo): Promise<void>;
}

/**
 * A Durable Object class serving `routes` on `fetch`, and the sockets `layerWebSocket` accepts
 * on `webSocketMessage`, `webSocketClose` and `webSocketError`, and running `alarm`. Export it,
 * or a class extending it, under the name the Wrangler configuration binds. Each instance
 * builds the routes once, in its constructor, with `State` provided, and holds every event
 * until they are built, as `blockConcurrencyWhile` does: a build that fails resets the
 * instance, and the next event builds them again. The runtime evicts an idle instance and
 * constructs a new one for the next event, so nothing the routes build is finalized, and
 * in-memory state lasts no longer than an instance.
 *
 * Guide: `docs/ActionDurableObject.md` in this package; in an application:
 * `examples/chat-rooms/`.
 */
export const make = <
  A,
  E,
  R extends Allowed<A>,
  AE = never,
  AR extends State | Scope.Scope = never,
>(
  options: Options<A, E, R, AE, AR>,
): new (ctx: DurableObjectState, env: Cloudflare.Env) => Instance => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased routes: the signature checked every request requirement against `Allowed<A>`, and `toWebHandler` gives each request the services the routes provide, `A`, as its own types say; only that subtraction, which a generic `A` keeps unresolved, is erased.
  const routes = options.routes as Layer.Layer<never, E, Allowed<never>>;

  const onAlarm:
    | ((info: AlarmInvocationInfo | undefined) => Effect.Effect<void, AE, State | Scope.Scope>)
    | undefined = options.alarm;

  return class ActionDurableObject extends DurableObject<Cloudflare.Env> {
    readonly #memoMap = Layer.makeMemoMapUnsafe();

    readonly #receivers = new Map<string, Receiver>();

    readonly #built = Deferred.makeUnsafe<void, unknown>();

    // Why: the runtime holds back a timer set outside the callback until it returns, so a build
    // started before it would wait on itself; started inside it, the build holds every event.
    readonly #web = this.ctx.blockConcurrencyWhile(async () => {
      const web = HttpRouter.toWebHandler(
        routes.pipe(
          Layer.tap(() => Deferred.succeed(this.#built, undefined)),
          Layer.tapCause((cause) => Deferred.failCause(this.#built, cause)),
          Layer.provide([
            Layer.succeed(State, this.ctx),
            Layer.succeed(Receivers, this.#receivers),
            HttpServer.layerServices,
          ]),
        ),
        { memoMap: this.#memoMap, disableLogger: options.disableLogger },
      );

      await Effect.runPromise(Deferred.await(this.#built));

      return web;
    });

    override async fetch(request: Request) {
      return (await this.#web).handler(request);
    }

    #receiverOf(socket: WebSocket) {
      const receiver = this.ctx
        .getTags(socket)
        .map((tag) => this.#receivers.get(tag))
        .find((found) => found !== undefined);

      if (receiver === undefined) {
        throw new Error(
          "No ActionDurableObject.layerWebSocket of these routes accepted this socket",
        );
      }

      return receiver;
    }

    override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
      return this.#receiverOf(socket).message(socket, message);
    }

    override webSocketClose(socket: WebSocket) {
      return this.#receiverOf(socket).close(socket);
    }

    override webSocketError(socket: WebSocket) {
      return this.#receiverOf(socket).close(socket);
    }

    declare readonly alarm?: (info?: AlarmInvocationInfo) => Promise<void>;

    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      super(ctx, env);

      // Why: the runtime refuses `storage.setAlarm` on an instance without an `alarm` handler,
      // at the call that sets it. Made without one, an instance has none, where a handler
      // rejecting every alarm would fail later, retried.
      if (onAlarm !== undefined) {
        this.alarm = (info) =>
          Effect.runPromise(
            onAlarm(info).pipe(
              Effect.scoped,
              Effect.provideService(State, this.ctx),
              Effect.provideService(Layer.CurrentMemoMap, this.#memoMap),
            ),
          );
      }
    }
  };
};

/** `layerWebSocket`'s options. */
export interface LayerWebSocketOptions {
  /** The upgrade route. */
  readonly path: HttpRouter.PathInput;
}

/**
 * The `RpcServer.Protocol` `ActionRpc.layer` serves on, in the routes of a class `make`
 * returns: WebSockets the object accepts at `path` for the runtime to hold while it hibernates,
 * speaking JSON, the client's `RpcSerialization.layerJson`. A message's event ends once the
 * message is handed to the server, and its calls answer after: one doing I/O or waiting on a
 * timer keeps the object from hibernating, and one waiting on memory alone is lost if it
 * hibernates. A socket keeps its upgrade request's headers, as Effect's own socket protocol
 * does, its credential included, and each message is authenticated with those under its own,
 * its own winning; an upgrade whose headers exceed the runtime's 16 KiB attachment is answered
 * 431. The runtime answers a client's pings without waking the object. Router middleware around
 * the routes runs for the upgrade request alone, never for a socket's messages. Each protocol
 * of one object needs a `path` of its own: a router prefix does not distinguish two.
 *
 * Guide: `docs/ActionDurableObject.md` in this package.
 */
export const layerWebSocket = (
  options: LayerWebSocketOptions,
): Layer.Layer<RpcServer.Protocol, never, State | HttpRouter.HttpRouter> =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const state = yield* State;
      const receivers = yield* Receivers;

      if (receivers === undefined) {
        return yield* Effect.die(
          new Error(
            "ActionDurableObject.layerWebSocket serves only the routes of a class ActionDurableObject.make returns",
          ),
        );
      }

      return yield* makeProtocol(state, receivers, options.path);
    }),
  );

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
