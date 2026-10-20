import { Context, Effect, Layer, Predicate, Queue, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { State } from "./state.js";

interface Receiver {
  readonly message: (socket: WebSocket, data: string | ArrayBuffer) => Effect.Effect<void>;
  readonly close: (socket: WebSocket) => Effect.Effect<void>;
}

// Why: registering is no concept of the dispatcher's own: only `layerWebSocket` registers, so
// the registry is reached through the dispatcher here rather than a method consumers would see.
const registries = new WeakMap<Sockets["Service"], Map<string, Receiver>>();

/**
 * The object's dispatcher for the sockets the protocols of its routes accept, such as
 * `layerWebSocket`'s: each method hands a socket's event to the protocol whose tag the socket
 * carries, and succeeds with `true` once that protocol has it, or with `false` when no protocol
 * accepted the socket, such as one the object accepted itself, which the caller answers. A
 * message's event ends once the message is handed to the server. `Sockets.layer` makes one per
 * instance, which the protocols register with as the routes build: dispatch once they are
 * built, through the one memo map they were built in, or a message finds no protocol yet.
 */
export class Sockets extends Context.Service<
  Sockets,
  {
    /** Hands a message on `socket`, as `webSocketMessage` receives it, to its protocol. */
    readonly message: (socket: WebSocket, data: string | ArrayBuffer) => Effect.Effect<boolean>;
    /** Tells the socket's protocol it closed, interrupting its running calls. */
    readonly close: (socket: WebSocket) => Effect.Effect<boolean>;
    /** Tells the socket's protocol it failed, which ends it as a close does. */
    readonly error: (socket: WebSocket) => Effect.Effect<boolean>;
  }
>()("effect-actions-cloudflare/ActionDurableObject/Sockets") {
  /** One dispatcher, with no protocol registered, for the instance whose `State` it is given. */
  static readonly layer: Layer.Layer<Sockets, never, State> = Layer.effect(Sockets)(
    Effect.map(Effect.service(State), (state) => {
      const receivers = new Map<string, Receiver>();

      const dispatch = (socket: WebSocket, event: (receiver: Receiver) => Effect.Effect<void>) =>
        Effect.suspend(() => {
          const receiver = state
            .getTags(socket)
            .map((tag) => receivers.get(tag))
            .find((found) => found !== undefined);

          return receiver === undefined ? Effect.succeed(false) : Effect.as(event(receiver), true);
        });

      const close = (socket: WebSocket) => dispatch(socket, (receiver) => receiver.close(socket));

      const sockets = Sockets.of({
        message: (socket, data) => dispatch(socket, (receiver) => receiver.message(socket, data)),
        close,
        error: close,
      });

      registries.set(sockets, receivers);

      return sockets;
    }),
  );
}

const Attachment = Schema.Struct({
  headers: Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
});

const attachmentOf = Schema.decodeUnknownSync(Schema.NullishOr(Attachment));

const json = RpcSerialization.json;

const encodeDefect = Schema.encodeSync(json.codecFor(Schema.Defect()));

const isRequest = (message: RpcMessage.FromClientEncoded): message is RpcMessage.RequestEncoded =>
  Predicate.isTagged(message, "Request");

/**
 * A hibernating `RpcServer.Protocol` over the object's WebSockets, speaking JSON, and its
 * upgrade route at `path`. Each socket carries two tags, its group's and its own id's, and keeps
 * its upgrade request's headers in its attachment, so both survive hibernation.
 */
const makeProtocol = (
  state: DurableObjectState,
  receivers: Map<string, Receiver>,
  path: HttpRouter.PathInput,
) =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const context = yield* Effect.context<never>();
    const parser = json.makeUnsafe();

    const group = `effect-actions/rpc:${path}`;

    // Why: the router does not tell a protocol the prefix it is mounted under, so two protocols
    // at one `path` would share their sockets' tags and answer each other's sockets.
    if (receivers.has(group)) {
      return yield* Effect.die(
        new Error(
          `Two ActionDurableObject.layerWebSocket protocols of one object serve the path ${path}: a router prefix does not tell them apart`,
        ),
      );
    }

    const idPrefix = `${group}#`;
    const tagOf = (id: number) => `${idPrefix}${id}`;

    const idOf = (socket: WebSocket) =>
      Number(
        state
          .getTags(socket)
          .find((tag) => tag.startsWith(idPrefix))
          ?.slice(idPrefix.length),
      );

    let nextId = Math.max(0, ...state.getWebSockets(group).map(idOf)) + 1;

    // Why: Effect's socket client pings every five seconds. Answered by the runtime, a ping never
    // wakes a hibernating object, which would otherwise stay billed for as long as a page is open.
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        String(parser.encode(RpcMessage.constPing)),
        String(parser.encode(RpcMessage.constPong)),
      ),
    );

    const disconnects = yield* Queue.make<number>();

    const sendTo = (clientId: number, response: RpcMessage.FromServerEncoded) => {
      const encoded = parser.encode(response);

      if (encoded === undefined) return;

      for (const socket of state.getWebSockets(tagOf(clientId))) socket.send(encoded);
    };

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
                write(
                  clientId,
                  isRequest(message)
                    ? { ...message, headers: [...headers, ...message.headers] }
                    : message,
                ),
              { discard: true },
            );
          }).pipe(
            Effect.catchDefect((defect) =>
              Effect.sync(() =>
                sendTo(clientId, RpcMessage.ResponseDefectEncoded(encodeDefect(defect))),
              ),
            ),
            Effect.provideContext(context),
          );
        },
        close: (socket) =>
          Effect.asVoid(Queue.offer(disconnects, idOf(socket))).pipe(
            Effect.provideContext(context),
          ),
      });

      return Effect.succeed({
        disconnects,
        send: (clientId, response) => Effect.sync(() => sendTo(clientId, response)),
        end: (clientId) =>
          Effect.sync(() => {
            for (const socket of state.getWebSockets(tagOf(clientId))) socket.close(1000);
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
          return HttpServerResponse.text("Expected a WebSocket upgrade", { status: 426 });
        }

        const { 0: client, 1: server } = new WebSocketPair();

        try {
          server.serializeAttachment(Attachment.make({ headers: Object.entries(request.headers) }));
        } catch {
          return HttpServerResponse.text("The headers a socket keeps exceed its attachment", {
            status: 431,
          });
        }

        state.acceptWebSocket(server, [group, tagOf(nextId++)]);

        return HttpServerResponse.raw(new Response(null, { status: 101, webSocket: client }), {
          status: 101,
        });
      }),
    );

    return protocol;
  });

/** `layerWebSocket`'s options. */
export interface LayerWebSocketOptions {
  /** The upgrade route. */
  readonly path: HttpRouter.PathInput;
}

/**
 * The `RpcServer.Protocol` `ActionRpc.layer` serves on, in an object's routes: WebSockets the
 * object accepts at `path` for the runtime to hold while it hibernates, speaking JSON, the
 * client's `RpcSerialization.layerJson`. It registers with the instance's `Sockets`, which
 * hands it their events. A message's event ends once the message is handed to the server, and
 * its calls answer after: one doing I/O or waiting on a timer keeps the object from
 * hibernating, and one waiting on memory alone is lost if it hibernates. A socket keeps its
 * upgrade request's headers, as Effect's own socket protocol does, its credential included, and
 * each message is authenticated with those under its own, its own winning. workerd keeps them
 * across hibernation; celld 0.6.2 drops them when it evicts an idle object, and the socket's
 * messages then carry only their own. An upgrade whose headers exceed the runtime's 16 KiB
 * attachment is answered 431. The runtime answers a client's pings without waking the object.
 * Router middleware around the routes runs for the upgrade request alone, never for a socket's
 * messages. Each protocol of one object needs a `path` of its own: a router prefix does not
 * distinguish two.
 *
 * Guide: `docs/ActionDurableObject.md` in this package.
 */
export const layerWebSocket = (
  options: LayerWebSocketOptions,
): Layer.Layer<RpcServer.Protocol, never, Sockets | State | HttpRouter.HttpRouter> =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const state = yield* State;
      const receivers = registries.get(yield* Sockets);

      if (receivers === undefined) {
        return yield* Effect.die(
          new Error(
            "ActionDurableObject.layerWebSocket registers only with a Sockets that Sockets.layer built",
          ),
        );
      }

      return yield* makeProtocol(state, receivers, options.path);
    }),
  );
