import { Context, Effect, Exit, Layer, Match, Predicate, Queue, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import {
  closeQuietly,
  groupTag,
  parser,
  RequestId,
  sendFrame,
  socketIdOf,
  socketTag,
} from "./frames.js";
import { State } from "./state.js";
import { makeSubscriptions } from "./subscriptions.js";

/** What a protocol does with the events of the sockets carrying its tag. */
interface Receiver {
  /** Hands a message to the protocol. */
  readonly message: (socket: WebSocket, data: string | ArrayBuffer) => Effect.Effect<void>;
  /** Tells the protocol the socket closed or failed. */
  readonly close: (socket: WebSocket) => Effect.Effect<void>;
}

/**
 * The object's dispatcher for the sockets the protocols of its routes accept, such as
 * `layerWebSocket`'s: each event method hands a socket's event to the protocol whose tag the
 * socket carries, and succeeds with `true` once that protocol has it, or with `false` when no
 * protocol accepted the socket, such as one the object accepted itself, which the caller answers.
 * `handlers` and `make` provide one per instance, which the protocols register with as the routes
 * build: a requirement of `layerWebSocket`, named as a type alone.
 *
 * **Gotchas**
 *
 * - A socket accepted by an earlier version of the routes at another `path` carries a tag no protocol holds now, and is answered `false`: close it, or serve that `path` again.
 */
export class Sockets extends Context.Service<
  Sockets,
  {
    /** Hands a message on `socket`, as `webSocketMessage` receives it, to its protocol. */
    readonly message: (socket: WebSocket, data: string | ArrayBuffer) => Effect.Effect<boolean>;
    /**
     * Completes the closing handshake of any socket, replying with the client's `code` and
     * `reason`, as `webSocketClose` receives them, and tells the socket's protocol it closed,
     * interrupting its running calls.
     */
    readonly close: (socket: WebSocket, code: number, reason: string) => Effect.Effect<boolean>;
    /** Tells the socket's protocol it failed, which ends it as a close does. */
    readonly error: (socket: WebSocket) => Effect.Effect<boolean>;
    /**
     * Hands the events of the sockets carrying `tag` to `receiver`, as a protocol builds, or
     * answers `false` when another protocol already holds that tag.
     */
    readonly register: (tag: string, receiver: Receiver) => boolean;
    /** The next socket's id, never one an open socket has or this instance gave before. */
    readonly allocate: Effect.Effect<number>;
  }
>()("effect-actions-cloudflare/ActionDurableObject/Sockets") {
  /** One dispatcher, with no protocol registered, for the instance whose `State` it is given. */
  static readonly layer: Layer.Layer<Sockets, never, State> = Layer.effect(Sockets)(
    Effect.gen(function* () {
      const state = yield* State;
      const receivers = new Map<string, Receiver>();

      let next = Math.max(
        1,
        ...state.getWebSockets().map((socket) => socketIdOf(state.getTags(socket)) + 1),
      );

      const dispatch = (socket: WebSocket, event: (receiver: Receiver) => Effect.Effect<void>) =>
        Effect.suspend(() => {
          const receiver = state
            .getTags(socket)
            .map((tag) => receivers.get(tag))
            .find((found) => found !== undefined);

          return receiver === undefined ? Effect.succeed(false) : Effect.as(event(receiver), true);
        });

      return Sockets.of({
        message: (socket, data) => dispatch(socket, (receiver) => receiver.message(socket, data)),
        close: (socket, code, reason) =>
          Effect.andThen(
            replyToClose(socket, code, reason),
            dispatch(socket, (receiver) => receiver.close(socket)),
          ),
        error: (socket) => dispatch(socket, (receiver) => receiver.close(socket)),
        register: (tag, receiver) => {
          if (receivers.has(tag)) return false;

          receivers.set(tag, receiver);

          return true;
        },
        allocate: Effect.sync(() => next++),
      });
    }),
  );
}

// Why: without the runtime's `web_socket_auto_reply_to_close`, before the `compatibility_date`
// `2026-04-07`, nothing answers a client's close frame, and every page closing a socket sees a
// 1006. Replying here, as Cloudflare's hibernation example does in `webSocketClose`, completes
// the handshake under any date, for a protocol's socket and one the object accepted itself
// alike, and a socket the runtime or the class already answered is left as it is.
const replyToClose = (socket: WebSocket, code: number, reason: string) =>
  Effect.sync(() =>
    code >= 1000 && code !== 1005 && code !== 1006 && code !== 1015
      ? closeQuietly(socket, code, reason)
      : closeQuietly(socket),
  );

// Why: `pending` holds the ids of the calls the socket sent that are not answered yet, in the
// attachment, which survives hibernation as storage does and costs no write, so an instance
// finds the calls the one before it was answering when it was evicted.
const Attachment = Schema.Struct({
  headers: Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
  pending: Schema.optional(Schema.Array(RequestId)),
});

const decodeAttachment = Schema.decodeUnknownExit(Schema.NullishOr(Attachment));

/** The socket's attachment, failing when it does not decode, or `undefined` with none. */
const attachmentOf = (socket: WebSocket) =>
  Exit.map(decodeAttachment(socket.deserializeAttachment()), (held) => held ?? undefined);

/** The socket's attachment, or `undefined` with none or one that does not decode. */
const heldOf = (socket: WebSocket) =>
  Exit.match(attachmentOf(socket), { onFailure: () => undefined, onSuccess: (held) => held });

const pendingOf = (socket: WebSocket) => heldOf(socket)?.pending ?? [];

// Why: answers whether the attachment holds the update, which it cannot past the runtime's 16
// KiB: a call whose id it cannot hold is refused, as an eviction would leave it unanswered on a
// socket kept open. One with no attachment to hold it, as on celld, is not tracked.
const tracked = (
  socket: WebSocket,
  update: (pending: ReadonlyArray<string | number>) => ReadonlyArray<string | number>,
) => {
  const held = heldOf(socket);

  if (held === undefined) return true;

  const pending = update(held.pending ?? []);

  try {
    socket.serializeAttachment(
      Attachment.make({ headers: held.headers, ...(pending.length > 0 && { pending }) }),
    );

    return true;
  } catch {
    return false;
  }
};

// Why: an exit answers its call, and a defect every call of its client, which fails them all.
const settledBy = (response: RpcMessage.FromServerEncoded) =>
  Match.value(response).pipe(
    Match.tag(
      "Exit",
      ({ requestId }) =>
        (pending: ReadonlyArray<string | number>) =>
          pending.filter((id) => id !== requestId),
    ),
    Match.tag("Defect", () => () => []),
    Match.orElse(() => undefined),
  );

const lostCalls = "This server lost the calls it was answering on this socket: connect again";

const untracked =
  "This socket's attachment, its upgrade's headers and the ids of its calls under way, would pass the runtime's 16 KiB: send fewer calls at once, or fewer or smaller headers on the upgrade";

const encodeDefect = Schema.encodeSync(RpcSerialization.json.codecFor(Schema.Defect()));

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
  sockets: Sockets["Service"],
  { path, protocol: version }: LayerWebSocketOptions,
) =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const context = yield* Effect.context<never>();

    const group = groupTag(path);

    const refusal = yield* refusalOf(version);

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
    const subscriptions = makeSubscriptions(state, path);

    // Why: every frame the object sends, a defect it answers a message with included, settles the
    // calls it answers, so a socket keeps no call pending that its client has already failed.
    const send = (clientId: number, response: RpcMessage.FromServerEncoded) =>
      Effect.andThen(
        sendFrame(state, clientId, response),
        Effect.andThen(
          Effect.sync(() => {
            const settled = settledBy(response);

            if (settled === undefined) return;

            for (const socket of state.getWebSockets(socketTag(clientId))) {
              tracked(socket, settled);
            }
          }),
          subscriptions.sent(clientId, response),
        ),
      );

    const protocol = yield* RpcServer.Protocol.make((write) => {
      const registered = sockets.register(group, {
        message: (socket, data) => {
          const clientId = idOf(socket);

          // Why: suspended, so a frame that does not parse, a message the server cannot read,
          // such as `null`, or an attachment that does not decode is answered with a defect, as
          // Effect's own socket protocol answers a frame, never rejecting the event, which a
          // runtime may answer by closing the socket. The event ends once each message is
          // written: a call doing I/O or waiting on a timer keeps the object from hibernating.
          return Effect.gen(function* () {
            // Why: workerd keeps a socket's attachment across hibernation; celld 0.6.2 drops
            // it when it evicts an idle object, and the socket arrives without one. It then has
            // no saved headers: a message carrying its own token still authenticates, and one
            // relying on the upgrade's is refused as unauthenticated.
            const headers = (yield* Effect.orDie(attachmentOf(socket)))?.headers ?? [];

            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- What a client sent: RpcServer checks each message's tag, id and payload, and a message it cannot read fails as a defect, answered as one.
            const messages = parser.decode(
              Predicate.isString(data) ? data : new Uint8Array(data),
            ) as ReadonlyArray<RpcMessage.FromClientEncoded>;

            const sent = messages.flatMap((message) =>
              Predicate.isTagged(message, "Request") ? [message.id] : [],
            );

            const kept = sent.length === 0 || tracked(socket, (pending) => [...pending, ...sent]);

            return yield* Effect.forEach(
              messages,
              (message) =>
                !Predicate.isTagged(message, "Request")
                  ? write(clientId, message)
                  : kept
                    ? write(clientId, { ...message, headers: [...headers, ...message.headers] })
                    : send(
                        clientId,
                        RpcMessage.ResponseExitDieEncoded({
                          requestId: RpcMessage.RequestId(message.id),
                          encodedDefect: encodeDefect(untracked),
                        }),
                      ),
              { discard: true },
            );
          }).pipe(
            Effect.catchDefect((defect) =>
              send(clientId, RpcMessage.ResponseDefectEncoded(encodeDefect(defect))),
            ),
            Effect.asVoid,
            Effect.provideContext(context),
          );
        },
        close: (socket) =>
          Effect.andThen(
            subscriptions.closed(idOf(socket)),
            Effect.asVoid(Queue.offer(disconnects, idOf(socket))),
          ),
      });

      // Why: the router does not tell a protocol the prefix it is mounted under, so two protocols
      // at one `path` would share their sockets' tags and answer each other's sockets.
      if (!registered) {
        return Effect.die(
          new Error(
            `Two ActionDurableObject.layerWebSocket protocols of one object serve the path ${path}: a router prefix does not tell them apart: give each its own path, such as /a/rpc and /b/rpc`,
          ),
        );
      }

      // Why: written as the protocol is made, the server buffering them until it runs, so the
      // subscriptions of the sockets kept open across hibernation resume before any message of
      // the event that woke the object, each authenticated again from its own headers.
      // Why: a call the instance before was answering when an eviction, a deploy or a crash cut
      // it off is never answered, and its client would wait on an open socket for good, since the
      // runtime answers its pings: its socket is closed with 1012, a restart, so the client fails
      // the call and connects again. A kept subscription among them resumes instead.
      const resumed = subscriptions.resumed(write, (socket, kept) => {
        if (pendingOf(socket).every(kept)) return true;

        closeQuietly(socket, 1012, lostCalls);

        return false;
      });

      return Effect.as(resumed, {
        disconnects,
        send,
        end: (clientId) =>
          Effect.sync(() => {
            for (const socket of state.getWebSockets(socketTag(clientId))) {
              closeQuietly(socket, 1000);
            }
          }),
        clientIds: Effect.sync(() => new Set(state.getWebSockets(group).map(idOf))),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: true,
        codecFor: RpcSerialization.json.codecFor,
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

        if (refusal !== undefined) {
          const { protocol: named } = yield* HttpServerRequest.ParsedSearchParams;

          if (named !== refusal.version) {
            return yield* refuseUpgrade(refusal.code, refusal.reason);
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

        state.acceptWebSocket(server, [group, socketTag(yield* sockets.allocate)]);

        return upgraded(client);
      }),
    );

    return { ...protocol, [ActionRpc.subscriptionKeeper]: subscriptions.keeper };
  });

const closeReasonBytes = 123;

const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;

// Why: a refusal's code is one of the private-use codes, 4000 to 4999, as the WHATWG WebSocket
// standard's `close()` takes them: the core's `watch` ends at a close with one of those, the
// server's on purpose, and connects again after any other, as after a drop, each upgrade waking
// the object. RFC 6455 §7.4.2 reserves 1000 to 2999 for the protocol and 3000 to 3999 for
// registered uses. The rule is checked here rather than on a socket pair made at build: an
// accepted end whose close goes unanswered keeps that build's request in flight, and an eviction
// waits for in-flight requests to drain.
const acceptedCode = (code: number) => Number.isInteger(code) && code >= 4000 && code <= 4999;

// Why: the runtime throws at `close` for a code or a reason it does not take, so a refusal judged
// only as a page of another version arrives, after a deploy, would fail that upgrade, which the
// page sees as a drop and its client connects again after for good: the loop the refusal ends.
const refusalOf = (protocol: LayerWebSocketOptions["protocol"]) =>
  Effect.gen(function* () {
    if (protocol === undefined) return undefined;

    const {
      version,
      code,
      reason = `This server speaks protocol ${version}: reload the page`,
    } = protocol;

    if (!acceptedCode(code)) {
      return yield* Effect.die(
        new Error(
          `ActionDurableObject.layerWebSocket's protocol.code ${code} is not one it accepts, an integer from 4000 to 4999, the codes a watch ends at: give one of those`,
        ),
      );
    }

    if (bytesOf(reason) > closeReasonBytes) {
      return yield* Effect.die(
        new Error(
          `ActionDurableObject.layerWebSocket's protocol.reason, given or the default naming its version, is ${bytesOf(reason)} bytes, more than the ${closeReasonBytes} a close frame holds: give a reason of at most ${closeReasonBytes} bytes, UTF-8 encoded`,
        ),
      );
    }

    return { version, code, reason };
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
 * - A 403, or any other status, reaches a browser's WebSocket as a bare 1006, as a network drop, and Effect's client connects again, half a second later and growing to every five seconds, for good.
 * - Effect's client connects again after this close as well, as often and for good, each upgrade waking the object, unless its `retryPolicy` is the core's `ActionRpc.reconnectUntil(code)`, the client half of this refusal.
 * - Its socket is accepted without the hibernation API and the library's route never runs, so the object keeps nothing of it; that accepted end ties up its request until the close handshake completes, so the object stays awake until the page answers the close.
 * - `code` is an integer from 4000 to 4999, the codes the core's `watch` ends at, connecting again after any other: another dies.
 */
export const refuseUpgrade = (
  code: number,
  reason: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.suspend(() => {
    if (!acceptedCode(code)) {
      return Effect.die(
        new Error(
          `ActionDurableObject.refuseUpgrade's code ${code} is not one it accepts, an integer from 4000 to 4999, the codes a watch ends at: give one of those`,
        ),
      );
    }

    const { 0: client, 1: server } = new WebSocketPair();

    server.accept();
    server.close(code, reason);

    return Effect.succeed(upgraded(client));
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
    /** The close code of a refusal, which a page's client stops at and its `watch` ends at: an integer from 4000 to 4999, the private-use codes; another fails `layerWebSocket`'s build. */
    readonly code: number;
    /** The close reason of a refusal, at most 123 bytes UTF-8 encoded, as a close frame holds: a longer one, the default included, fails `layerWebSocket`'s build. By default `This server speaks protocol <version>: reload the page`, which fits a `version` of up to 78 bytes: give a reason with a longer one. */
    readonly reason?: string;
  };
}

/**
 * The `RpcServer.Protocol` `ActionRpc.layer` serves on, in an object's routes: WebSockets the
 * object accepts at `path`, with the runtime's hibernation API, for the runtime to hold while
 * the object hibernates, speaking JSON, the client's `RpcSerialization.layerJson` over
 * `RpcClient.layerProtocolSocket`. A socket keeps its upgrade request's headers, as Effect's own
 * socket protocol does, its credential included, and each message is authenticated with those
 * under its own, its own winning. It keeps each event subscription `ActionRpc.layer` admits
 * across hibernation. It registers with the instance's `Sockets`, which hands it their events,
 * and requires it.
 *
 * **Gotchas**
 *
 * - An idle object is evicted while its sockets stay open: a message constructs a new instance, which builds the routes and then answers it.
 * - A message's event ends once the message is handed to the server: a call doing I/O or waiting on a timer keeps the object from hibernating, billed as long, and one waiting only on in-memory state, such as a `Deferred`, is lost if the object hibernates. A call an eviction, a deploy or a crash cut off closes its socket with 1012 as the next instance builds, so its client fails it with a `SocketCloseError` and connects again; on celld 0.6.2, which drops attachments, it waits for good.
 * - An `ActionRpc` event subscription is kept in the object's storage, under `effect-actions/subscription/`, its headers, tokens and cookies included, with it, and resumed from the position it reached when the object next wakes, on any event, authenticated again from those headers: a token that expired meanwhile ends it with `Unauthenticated`.
 * - A kept subscription that cannot be resumed, such as one a later version of this package stores in another shape, closes its socket with 1000, logged, so the page's client connects again and its `watch` subscribes anew.
 * - A native stream rpc or a streaming action is not kept: waiting on in-memory state, it is lost if the object hibernates, its socket closed with 1012 as the next instance builds; serve what a page follows as an event.
 * - Each chunk that moves a kept subscription's position is one small storage write, and it is sent with no heartbeat: Effect's socket client tells a dead socket by its pings.
 * - `storage.deleteAll()` deletes the kept subscriptions too, so a watch hears nothing more once the object hibernates: close the sockets with it, so their clients connect again and watch anew.
 * - A client's close frame is answered with its own code and reason, as the closing handshake asks, whatever the `compatibility_date`: where the runtime already replied, under `web_socket_auto_reply_to_close`, the second reply is ignored; a socket the class accepted itself is the class's to answer.
 * - An upgrade whose headers, cookies included, exceed the runtime's 16 KiB attachment is answered 431, and a call whose id would take the attachment past it fails at once with a defect naming it, never run; a request to `path` that is no upgrade is answered 426.
 * - workerd keeps a socket's headers across hibernation; celld 0.6.2 drops them when it evicts an idle object, so a message relying on the upgrade's token is refused as unauthenticated: send a token on each message.
 * - The upgrade's URL and query are not kept, as Effect's own socket protocol keeps neither: a message has no URL, so an API key in the query never authenticates; `protocol` reads the upgrade's query for a version, and router middleware reads it for any other judge, refusing with `refuseUpgrade`.
 * - A browser WebSocket sets no header on its upgrade, so a page sends its token on each message, with `RpcClient.withHeaders`; under a cookie scheme the browser sends the cookie on any page's upgrade, which is never preflighted, so refuse a foreign `Origin` with router middleware, which runs for the upgrade, returning `refuseUpgrade`: a 403 reaches the page as a bare 1006, and its client connects again for good.
 * - The verifier runs for every message, so a token that expires refuses the next call: a client renews it on its messages, or connects again.
 * - Router middleware around the routes runs for the upgrade request alone, never for a socket's messages: list an `RpcMiddleware` in `ActionRpc.layer`'s `middleware` for a per-message service.
 * - Each protocol of one object needs a `path` of its own: a router prefix does not tell two apart, and two at one `path` fail the build.
 * - The runtime answers a client's pings itself, every five seconds, so an open page does not wake the object.
 * - Effect's `RpcServer.layerProtocolWebsocket` cannot upgrade a web handler's request: on Workers, serve sockets with this.
 * - A handler's die under a plain `RpcServer.layer` is Effect's fatal `Defect`, failing every call in flight on that socket, a call made in the dying one's continuation included, as Effect's own design, unlike over the object's stub: serve with `RpcServer.layer(group, { disableFatalDefects: true })`, or through `ActionRpc.layer`, to fail that call alone.
 */
export const layerWebSocket = (
  options: LayerWebSocketOptions,
): Layer.Layer<RpcServer.Protocol, never, Sockets | State | HttpRouter.HttpRouter> =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      return yield* makeProtocol(yield* State, yield* Sockets, options);
    }),
  );
