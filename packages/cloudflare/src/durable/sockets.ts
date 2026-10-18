import { Effect, Predicate, Queue, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import type { Header } from "./credential.js";

/** What an object hands a socket's events to: the protocol whose tag the socket carries. */
export interface Receiver {
  readonly message: (socket: WebSocket, data: string | ArrayBuffer) => Promise<void>;
  readonly close: (socket: WebSocket) => Promise<void>;
}

const receivers = new WeakMap<DurableObjectState, Map<string, Receiver>>();

/**
 * The receivers the protocols of an object's instance registered as they were built, under
 * their sockets' group tag: what its socket events are handed to.
 */
export const receiversOf = (state: DurableObjectState): Map<string, Receiver> => {
  const registered = receivers.get(state) ?? new Map<string, Receiver>();

  receivers.set(state, registered);

  return registered;
};

const Attachment = Schema.Struct({
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const attachmentOf = Schema.decodeUnknownSync(Attachment);

const json = RpcSerialization.json;

const encodeDefect = Schema.encodeSync(json.codecFor(Schema.Defect()));

const isRequest = (message: RpcMessage.FromClientEncoded): message is RpcMessage.RequestEncoded =>
  Predicate.isTagged(message, "Request");

/**
 * A hibernating `RpcServer.Protocol` over the object's WebSockets, speaking JSON, and its
 * upgrade route at `path`. Each socket carries two tags, its group's and its own id's, and keeps
 * `saved` of its upgrade request in its attachment, so both survive hibernation; a message
 * resolves once every request in it has its exit.
 */
export const makeProtocol = (
  state: DurableObjectState,
  options: {
    readonly path: HttpRouter.PathInput;
    readonly saved: (request: HttpServerRequest.HttpServerRequest) => ReadonlyArray<Header>;
  },
) =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const parser = json.makeUnsafe();

    const group = `effect-actions/rpc:${options.path}`;
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
    const awaitingExit = new Map<number, Map<string, () => void>>();

    const exited = (clientId: number, requestId: string) => {
      awaitingExit.get(clientId)?.get(requestId)?.();
      awaitingExit.get(clientId)?.delete(requestId);
    };

    const allExited = (clientId: number) => {
      for (const resolve of awaitingExit.get(clientId)?.values() ?? []) resolve();
      awaitingExit.delete(clientId);
    };

    const exitOf = (clientId: number, requestId: string) =>
      new Promise<void>((resolve) => {
        const ofClient = awaitingExit.get(clientId) ?? new Map<string, () => void>();

        awaitingExit.set(clientId, ofClient.set(requestId, resolve));
      });

    const sendTo = (clientId: number, response: RpcMessage.FromServerEncoded) => {
      const encoded = parser.encode(response);

      if (encoded === undefined) return;

      for (const socket of state.getWebSockets(tagOf(clientId))) socket.send(encoded);
    };

    const protocol = yield* RpcServer.Protocol.make((write) => {
      receiversOf(state).set(group, {
        message: async (socket, data) => {
          const clientId = idOf(socket);
          const { headers } = attachmentOf(socket.deserializeAttachment());

          let messages: ReadonlyArray<RpcMessage.FromClientEncoded>;

          try {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- What a client sent: RpcServer checks each message's tag, id and payload itself, as over Effect's own socket protocol.
            messages = parser.decode(
              Predicate.isString(data) ? data : new Uint8Array(data),
            ) as ReadonlyArray<RpcMessage.FromClientEncoded>;
          } catch (cause) {
            return sendTo(clientId, RpcMessage.ResponseDefectEncoded(encodeDefect(cause)));
          }

          const exits = messages.filter(isRequest).map(({ id }) => exitOf(clientId, String(id)));

          for (const message of messages) {
            await run(
              write(
                clientId,
                isRequest(message)
                  ? {
                      ...message,
                      headers: [
                        ...headers.map(([name, value]): [string, string] => [name, value]),
                        ...message.headers,
                      ],
                    }
                  : message,
              ),
            );
          }

          await Promise.all(exits);
        },
        close: async (socket) => {
          const clientId = idOf(socket);

          allExited(clientId);

          await run(Queue.offer(disconnects, clientId));
        },
      });

      return Effect.succeed({
        disconnects,
        send: (clientId, response) =>
          Effect.sync(() => {
            sendTo(clientId, response);

            if (Predicate.isTagged(response, "Exit")) exited(clientId, String(response.requestId));

            if (Predicate.isTagged(response, "Defect")) allExited(clientId);
          }),
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
      options.path,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        if (request.headers["upgrade"]?.toLowerCase() !== "websocket") {
          return HttpServerResponse.text("Expected a WebSocket upgrade", { status: 426 });
        }

        const { 0: client, 1: server } = new WebSocketPair();

        state.acceptWebSocket(server, [group, tagOf(nextId++)]);
        server.serializeAttachment(Attachment.make({ headers: options.saved(request) }));

        return HttpServerResponse.raw(new Response(null, { status: 101, webSocket: client }));
      }),
    );

    return protocol;
  });
