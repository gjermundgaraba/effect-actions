import { Context, Effect, Predicate, Queue, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";

/** What an object hands a socket's events to: the protocol whose tag the socket carries. */
export interface Receiver {
  readonly message: (socket: WebSocket, data: string | ArrayBuffer) => Promise<void>;
  readonly close: (socket: WebSocket) => Promise<void>;
}

/**
 * The receivers an instance's protocols register as they are built, under their sockets' group
 * tag: what `make` hands its socket events to. `make` provides one per instance; without it,
 * nothing would receive a socket's events.
 */
export const Receivers = Context.Reference<Map<string, Receiver> | undefined>(
  "effect-actions-cloudflare/ActionDurableObject/Receivers",
  { defaultValue: () => undefined },
);

const Attachment = Schema.Struct({
  headers: Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
});

const attachmentOf = Schema.decodeUnknownSync(Attachment);

const json = RpcSerialization.json;

const encodeDefect = Schema.encodeSync(json.codecFor(Schema.Defect()));

const isRequest = (message: RpcMessage.FromClientEncoded): message is RpcMessage.RequestEncoded =>
  Predicate.isTagged(message, "Request");

/**
 * A hibernating `RpcServer.Protocol` over the object's WebSockets, speaking JSON, and its
 * upgrade route at `path`. Each socket carries two tags, its group's and its own id's, and keeps
 * its upgrade request's headers in its attachment, so both survive hibernation.
 */
export const makeProtocol = (
  state: DurableObjectState,
  receivers: Map<string, Receiver>,
  path: HttpRouter.PathInput,
) =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
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
          const { headers } = attachmentOf(socket.deserializeAttachment());

          // Why: suspended, so a frame that does not parse, or a message the server cannot
          // read, such as `null`, is answered with a defect, as Effect's own socket protocol
          // answers it, never rejecting the event. The event ends once each message is written:
          // a call doing I/O or waiting on a timer keeps the object from hibernating.
          return run(
            Effect.suspend(() =>
              Effect.forEach(
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
              ),
            ).pipe(
              Effect.catchDefect((defect) =>
                Effect.sync(() =>
                  sendTo(clientId, RpcMessage.ResponseDefectEncoded(encodeDefect(defect))),
                ),
              ),
            ),
          );
        },
        close: (socket) => run(Effect.asVoid(Queue.offer(disconnects, idOf(socket)))),
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
