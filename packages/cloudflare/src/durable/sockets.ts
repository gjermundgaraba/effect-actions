import { Context, Effect, Layer, Option, Predicate, Queue, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { Feed } from "@gjermundgaraba/effect-actions/Feed";
import { CurrentSocket, forget, servePath } from "./feed.js";
import { groupTag, sendFrame, socketIdOf, socketTag } from "./frames.js";
import { makeRegistries } from "./registry.js";
import { State } from "./state.js";

interface Receiver {
  readonly message: (socket: WebSocket, data: string | ArrayBuffer) => Effect.Effect<void>;
  readonly close: (socket: WebSocket) => Effect.Effect<void>;
}

interface Registry {
  readonly receivers: Map<string, Receiver>;
  /** The next socket's id, never one an earlier socket of the object had. */
  readonly allocate: Effect.Effect<number>;
}

const nextSocketKey = "effect-actions/socket/next";

const registries = makeRegistries<Sockets["Service"], Registry>(
  "layerWebSocket",
  "Sockets",
  "Sockets.layer",
);

/**
 * The object's dispatcher for the sockets the protocols of its routes accept, such as
 * `layerWebSocket`'s: each method hands a socket's event to the protocol whose tag the socket
 * carries, and succeeds with `true` once that protocol has it, or with `false` when no protocol
 * accepted the socket, such as one the object accepted itself, which the caller answers.
 * `Sockets.layer` makes one per instance, which the protocols register with as the routes build;
 * `handlers` and `make` provide it.
 *
 * **Gotchas**
 *
 * - A message dispatched before the routes are built finds no protocol registered and is answered `false`: in a class composing the primitives itself, await the routes' build first, or delegate to `handlers`, which does.
 * - The runtime dispatching through `Sockets` and `toWebHandler` must build in one memo map: given two, each builds `Sockets.layer`, `layerWebSocket` registers with one, and every socket's messages go unanswered, with no error.
 * - A socket accepted by an earlier version of the routes at another `path` carries a tag no protocol holds now, and is answered `false`: close it, or serve that `path` again.
 * - The socket-id counter is kept in the object's storage, beside the application's data: wipe that storage with `wipe`.
 */
export class Sockets extends Context.Service<
  Sockets,
  {
    /** Hands a message on `socket`, as `webSocketMessage` receives it, to its protocol. */
    readonly message: (socket: WebSocket, data: string | ArrayBuffer) => Effect.Effect<boolean>;
    /**
     * Tells the socket's protocol it closed, interrupting its running calls, and completes the
     * closing handshake, replying with the client's `code` and `reason`, as `webSocketClose`
     * receives them.
     */
    readonly close: (socket: WebSocket, code: number, reason: string) => Effect.Effect<boolean>;
    /** Tells the socket's protocol it failed, which ends it as a close does. */
    readonly error: (socket: WebSocket) => Effect.Effect<boolean>;
  }
>()("effect-actions-cloudflare/ActionDurableObject/Sockets") {
  /** One dispatcher, with no protocol registered, for the instance whose `State` it is given. */
  static readonly layer: Layer.Layer<Sockets, never, State> = Layer.effect(Sockets)(
    Effect.gen(function* () {
      const state = yield* State;
      const receivers = new Map<string, Receiver>();

      // Why: a socket's id names its subscribers' records, which outlive it until a publish
      // meets them, so an id is never given twice: the next one is kept in storage.
      const stored = yield* Effect.promise(() => state.storage.get(nextSocketKey));

      let next = Math.max(
        Option.getOrElse(storedIdOf(stored), () => 1),
        ...state.getWebSockets().map((socket) => socketIdOf(state.getTags(socket)) + 1),
      );

      // Why: stored as each id is given, before its socket is accepted, so no eviction, however
      // soon, lets a later instance give that id again: an upgrade costs one storage write.
      const allocate = Effect.suspend(() => {
        const id = next++;

        return Effect.as(
          Effect.promise(() => state.storage.put(nextSocketKey, next)),
          id,
        );
      });

      const dispatch = (socket: WebSocket, event: (receiver: Receiver) => Effect.Effect<void>) =>
        Effect.suspend(() => {
          const receiver = state
            .getTags(socket)
            .map((tag) => receivers.get(tag))
            .find((found) => found !== undefined);

          return receiver === undefined ? Effect.succeed(false) : Effect.as(event(receiver), true);
        });

      const sockets = Sockets.of({
        message: (socket, data) => dispatch(socket, (receiver) => receiver.message(socket, data)),
        close: (socket, code, reason) =>
          dispatch(socket, (receiver) =>
            Effect.andThen(replyToClose(socket, code, reason), receiver.close(socket)),
          ),
        error: (socket) => dispatch(socket, (receiver) => receiver.close(socket)),
      });

      registries.register(sockets, { receivers, allocate });

      return sockets;
    }),
  );
}

const storedIdOf = Schema.decodeUnknownOption(Schema.Int);

// Why: without the runtime's `web_socket_auto_reply_to_close`, before the `compatibility_date`
// `2026-04-07`, nothing answers a client's close frame, and every page closing a socket sees a
// 1006. Replying here, as Cloudflare's hibernation example does in `webSocketClose`, completes
// the handshake under any date; a socket the runtime already answered refuses the second close,
// which is ignored.
const replyToClose = (socket: WebSocket, code: number, reason: string) =>
  Effect.ignore(
    Effect.try(() =>
      code >= 1000 && code !== 1005 && code !== 1006 && code !== 1015
        ? socket.close(code, reason)
        : socket.close(),
    ),
  );

const Attachment = Schema.Struct({
  headers: Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
});

const attachmentOf = Schema.decodeUnknownSync(Schema.NullishOr(Attachment));

const json = RpcSerialization.json;

const encodeDefect = Schema.encodeSync(json.codecFor(Schema.Defect()));

// Why: `HttpServerResponse.raw` takes its status from its options, not from the web `Response`
// it carries, and the request logger and the server's span read that status: without it, every
// upgrade is logged and traced as 200.
const upgraded = (client: WebSocket) =>
  HttpServerResponse.raw(new Response(null, { status: 101, webSocket: client }), { status: 101 });

/**
 * A hibernating `RpcServer.Protocol` over the object's WebSockets, speaking JSON, and its
 * upgrade route at `path`. Each socket carries two tags, its group's and its own id's, and keeps
 * its upgrade request's headers in its attachment, so both survive hibernation.
 */
const makeProtocol = (
  state: DurableObjectState,
  { receivers, allocate }: Registry,
  { path, protocol: version }: LayerWebSocketOptions,
) =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const context = yield* Effect.context<never>();
    const parser = json.makeUnsafe();

    const group = groupTag(path);

    // Why: the router does not tell a protocol the prefix it is mounted under, so two protocols
    // at one `path` would share their sockets' tags and answer each other's sockets.
    if (receivers.has(group)) {
      return yield* Effect.die(
        new Error(
          `Two ActionDurableObject.layerWebSocket protocols of one object serve the path ${path}: a router prefix does not tell them apart: give each its own path, such as /a/rpc and /b/rpc`,
        ),
      );
    }

    const idOf = (socket: WebSocket) => socketIdOf(state.getTags(socket));

    // Why: Effect's socket client pings every five seconds. Answered by the runtime, a ping never
    // wakes a hibernating object, which would otherwise stay billed for as long as a page is open.
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        String(parser.encode(RpcMessage.constPing)),
        String(parser.encode(RpcMessage.constPong)),
      ),
    );

    const disconnects = yield* Queue.make<number>();

    const protocol = yield* RpcServer.Protocol.make((write) => {
      receivers.set(group, {
        message: (socket, data) => {
          const clientId = idOf(socket);

          // Why: suspended, so a frame that does not parse, a message the server cannot read,
          // such as `null`, or an attachment that does not decode is answered with a defect, as
          // Effect's own socket protocol answers a frame, never rejecting the event, which a
          // runtime may answer by closing the socket. The event ends once each message is
          // written: a call doing I/O or waiting on a timer keeps the object from hibernating.
          return Effect.suspend(() => {
            // Why: workerd keeps a socket's attachment across hibernation; celld 0.6.2 drops
            // it when it evicts an idle object, and the socket arrives without one. It then has
            // no saved headers: a message carrying its own token still authenticates, and one
            // relying on the upgrade's is refused as unauthenticated.
            const headers = attachmentOf(socket.deserializeAttachment())?.headers ?? [];

            return Effect.forEach(
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- What a client sent: RpcServer checks each message's tag, id and payload, and a message it cannot read fails as a defect, answered as one.
              parser.decode(
                Predicate.isString(data) ? data : new Uint8Array(data),
              ) as ReadonlyArray<RpcMessage.FromClientEncoded>,
              (message) =>
                Effect.andThen(
                  // Why: a subscriber's record outlives the server's request, which hibernation
                  // drops, so the client's interruption is what ends it.
                  Predicate.isTagged(message, "Interrupt")
                    ? forget(state.storage, clientId, message.requestId)
                    : Effect.void,
                  // Why: Effect's server runs a request's handler in the context of the fiber
                  // that wrote it, so the socket reaches `Feed.subscribe` in it, where no caller
                  // can set it, as one could a header.
                  write(
                    clientId,
                    Predicate.isTagged(message, "Request")
                      ? { ...message, headers: [...headers, ...message.headers] }
                      : message,
                  ).pipe(Effect.provideService(CurrentSocket, Option.some(clientId))),
                ),
              { discard: true },
            );
          }).pipe(
            Effect.catchDefect((defect) =>
              sendFrame(state, clientId, RpcMessage.ResponseDefectEncoded(encodeDefect(defect))),
            ),
            Effect.asVoid,
            Effect.provideContext(context),
          );
        },
        close: (socket) =>
          forget(state.storage, idOf(socket)).pipe(
            Effect.andThen(Queue.offer(disconnects, idOf(socket))),
            Effect.asVoid,
            Effect.provideContext(context),
          ),
      });

      return Effect.succeed({
        disconnects,
        send: (clientId, response) => Effect.asVoid(sendFrame(state, clientId, response)),
        end: (clientId) =>
          Effect.sync(() => {
            for (const socket of state.getWebSockets(socketTag(clientId))) socket.close(1000);
          }),
        clientIds: Effect.sync(() => new Set(state.getWebSockets(group).map(idOf))),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: true,
        codecFor: json.codecFor,
      });
    });

    yield* router.add(
      "GET",
      path,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        if (request.headers["upgrade"]?.toLowerCase() !== "websocket") {
          return HttpServerResponse.text(
            "Expected a WebSocket upgrade: connect with a WebSocket client, or forward the page's own Request to the object",
            { status: 426 },
          );
        }

        if (version !== undefined) {
          const { [version.parameter ?? "protocol"]: named } =
            yield* HttpServerRequest.ParsedSearchParams;

          if (named !== version.version) {
            return yield* refuseUpgrade(
              version.code,
              version.reason ?? `This server speaks protocol ${version.version}: reload the page`,
            );
          }
        }

        const { 0: client, 1: server } = new WebSocketPair();

        try {
          server.serializeAttachment(Attachment.make({ headers: Object.entries(request.headers) }));
        } catch {
          return HttpServerResponse.text(
            "The headers a socket keeps exceed its attachment: send fewer or smaller cookies to this path, or the token on each message",
            {
              status: 431,
            },
          );
        }

        state.acceptWebSocket(server, [group, socketTag(yield* allocate)]);

        return upgraded(client);
      }),
    );

    return protocol;
  });

/**
 * The answer router middleware gives a WebSocket upgrade it refuses, such as one from a foreign
 * `Origin`, as `layerWebSocket`'s `protocol` refuses a page of another version: 101, with a socket of its own closed at once with
 * `code` and `reason`, which the page's Effect client fails its calls and streams with, as
 * `SocketCloseError`. A browser cannot read the status of an upgrade it was refused, so this is
 * how a refusal reaches the page.
 *
 * **Gotchas**
 *
 * - A 403, or any other status, reaches a browser's WebSocket as a bare 1006, as a network drop, and Effect's client connects again, every few seconds for good.
 * - Effect's client connects again after this close as well, every five seconds for good, each upgrade waking the object, unless its `retryPolicy` is the core's `ActionRpc.reconnectUntil(code)`, the client half of this refusal.
 * - Its socket is accepted without the hibernation API and the library's route never runs, so the object keeps nothing of it.
 */
export const refuseUpgrade = (
  code: number,
  reason: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.sync(() => {
    const { 0: client, 1: server } = new WebSocketPair();

    server.accept();
    server.close(code, reason);

    return upgraded(client);
  });

/** `layerWebSocket`'s options. */
export interface LayerWebSocketOptions {
  /** The upgrade route. */
  readonly path: HttpRouter.PathInput;
  /**
   * The version of the rpcs the route serves, which a page names in its socket's URL, as
   * `?protocol=<version>`: an upgrade naming none, or another, is refused with
   * `refuseUpgrade(code, reason)`, which a page's client stops at given the core's
   * `ActionRpc.reconnectUntil(code)`.
   */
  readonly protocol?: {
    /** The version served, compared with the query parameter as a string. */
    readonly version: string;
    /** The close code of a refusal, 4000 to 4999 for an application's own. */
    readonly code: number;
    /** The close reason of a refusal, at most 123 bytes, as a close frame holds; by default it names `version` and asks for a reload. */
    readonly reason?: string;
    /** The query parameter naming the version; `protocol` by default. */
    readonly parameter?: string;
  };
}

/**
 * The `RpcServer.Protocol` `ActionRpc.layer` serves on, in an object's routes: WebSockets the
 * object accepts at `path`, with the runtime's hibernation API, for the runtime to hold while
 * the object hibernates, speaking JSON, the client's `RpcSerialization.layerJson` over
 * `RpcClient.layerProtocolSocket`. A socket keeps its upgrade request's headers, as Effect's own
 * socket protocol does, its credential included, and each message is authenticated with those
 * under its own, its own winning. It registers with the instance's `Sockets`, which hands it
 * their events, and its `Feed`, which serves its sockets, and requires both.
 *
 * **Gotchas**
 *
 * - An idle object is evicted while its sockets stay open: a message constructs a new instance, which builds the routes and then answers it.
 * - A message's event ends once the message is handed to the server: a call doing I/O or waiting on a timer keeps the object from hibernating, billed as long, and one waiting only on in-memory state, such as a `Deferred`, is lost if the object hibernates, its client never hearing back.
 * - A client's close frame is answered with its own code and reason, as the closing handshake asks, whatever the `compatibility_date`: where the runtime already replied, under `web_socket_auto_reply_to_close`, the second reply is ignored; a socket the class accepted itself is the class's to answer.
 * - An upgrade whose headers, cookies included, exceed the runtime's 16 KiB attachment is answered 431; a request to `path` that is no upgrade is answered 426.
 * - workerd keeps a socket's headers across hibernation; celld 0.6.2 drops them when it evicts an idle object, so a message relying on the upgrade's token is refused as unauthenticated: send a token on each message.
 * - The upgrade's URL and query are not kept, as Effect's own socket protocol keeps neither: a message has no URL, so an API key in the query never authenticates; `protocol` reads the upgrade's query for a version, and router middleware reads it for any other judge, refusing with `refuseUpgrade`.
 * - A browser WebSocket sets no header on its upgrade, so a page sends its token on each message, with `RpcClient.withHeaders`; under a cookie scheme the browser sends the cookie on any page's upgrade, which is never preflighted, so refuse a foreign `Origin` with router middleware, which runs for the upgrade, returning `refuseUpgrade`: a 403 reaches the page as a bare 1006, and its client connects again for good.
 * - The verifier runs for every message, so a token that expires refuses the next call: a client renews it on its messages, or connects again.
 * - Router middleware around the routes runs for the upgrade request alone, never for a socket's messages: list an `RpcMiddleware` in `ActionRpc.layer`'s `middleware` for a per-message service.
 * - Each protocol of one object needs a `path` of its own: a router prefix does not tell two apart, and two at one `path` fail the build.
 * - The runtime answers a client's pings itself, every five seconds, so an open page does not wake the object.
 * - Effect's `RpcServer.layerProtocolWebsocket` cannot upgrade a web handler's request: on Workers, serve sockets with this.
 * - A handler's die under a plain `RpcServer.layer` is Effect's fatal `Defect`, failing every call in flight on that socket, a call made in the dying one's continuation included, as Effect's own design, unlike over `layerStub`: serve with `RpcServer.layer(group, { disableFatalDefects: true })`, or through `ActionRpc.layer`, to fail that call alone.
 *
 * Guide: `docs/ActionDurableObject.md` in this package.
 */
export const layerWebSocket = (
  options: LayerWebSocketOptions,
): Layer.Layer<RpcServer.Protocol, never, Sockets | Feed | State | HttpRouter.HttpRouter> =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const state = yield* State;
      const registry = yield* registries.of(yield* Sockets);
      const protocol = yield* makeProtocol(state, registry, options);

      yield* servePath(yield* Feed, options.path);

      return protocol;
    }),
  );
