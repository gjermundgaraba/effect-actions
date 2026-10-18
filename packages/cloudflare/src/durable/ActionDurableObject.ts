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
import type * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { savedOf } from "./credential.js";
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

type Allowed =
  | State
  | HttpRouter.HttpRouter
  | Layer.Success<typeof HttpServer.layerServices>
  | HttpRouter.Request<"Requires", ServedPerRequest>
  | HttpRouter.Request<"GlobalRequires", ServedPerRequest>
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>;

/** `make`'s options. */
export interface Options<E = never, R = never, AE = never, AR = never> {
  /**
   * What `fetch` serves: routes, as `HttpRouter.toWebHandler` serves them, such as
   * `ActionRpc.layer` over `layerWebSocket` and `ActionHttp.layer`. Built when the instance is,
   * again after every eviction, and never finalized. They may require `State`; a request-time
   * requirement must be provided by their middleware or authentication.
   */
  readonly routes: Layer.Layer<never, E, R>;
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

/** An instance of a class `make` returns, with the handlers it defines. */
export interface Instance extends DurableObject<Cloudflare.Env> {
  fetch(request: Request): Promise<Response>;
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(socket: WebSocket): Promise<void>;
  webSocketError(socket: WebSocket): Promise<void>;
  alarm(info?: AlarmInvocationInfo): Promise<void>;
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
export const make = <E, R extends Allowed, AE = never, AR extends State | Scope.Scope = never>(
  options: Options<E, R, AE, AR>,
): new (ctx: DurableObjectState, env: Cloudflare.Env) => Instance => {
  const routes: Layer.Layer<never, E, Allowed> = options.routes;

  const alarm:
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

    override alarm(info?: AlarmInvocationInfo) {
      if (alarm === undefined) {
        return Promise.reject(new Error("ActionDurableObject.make was given no alarm"));
      }

      return Effect.runPromise(
        alarm(info).pipe(
          Effect.scoped,
          Effect.provideService(State, this.ctx),
          Effect.provideService(Layer.CurrentMemoMap, this.#memoMap),
        ),
      );
    }
  };
};

/** `layerWebSocket`'s options. */
export interface LayerWebSocketOptions {
  /** The upgrade route. */
  readonly path: HttpRouter.PathInput;
  /**
   * Headers of the upgrade request each message is sent again, besides the credential the
   * binding's descriptor reads, such as one naming a room: a message's own headers win.
   */
  readonly headers?: ReadonlyArray<string> | undefined;
}

/**
 * The `RpcServer.Protocol` `ActionRpc.layer` serves `binding` on, in the routes of a class
 * `make` returns: WebSockets the object accepts at `path` for the runtime to hold while it
 * hibernates, speaking JSON, the client's `RpcSerialization.layerJson`. `binding` is the one
 * `ActionRpc.layer` serves, and only `ActionRpc.layer` serves on it: a message's event lasts
 * until each of its requests has its exit, which `ActionRpc.layer` always sends, where
 * `RpcServer.layer` answers a handler's defect without one, holding the event, and the object
 * awake, until the socket closes. A socket keeps from its upgrade request the credential the
 * binding's descriptor reads, an `Authorization` header, an API key's header or its cookie,
 * and the headers listed, and nothing else: Effect's own socket protocol keeps every header.
 * Each message is authenticated with those and its own headers, its own winning. The runtime
 * answers a client's pings without waking the object. Router middleware around the routes
 * runs for the upgrade request alone, never for a socket's messages. Each protocol of one
 * object needs a `path` of its own: a router prefix does not distinguish two.
 *
 * Guide: `docs/ActionDurableObject.md` in this package.
 */
export const layerWebSocket = (
  binding: ActionRpc.Any,
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

      return yield* makeProtocol(state, receivers, {
        path: options.path,
        saved: savedOf(binding, options.headers ?? []),
      });
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
