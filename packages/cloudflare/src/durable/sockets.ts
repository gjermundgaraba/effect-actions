import { Context, Effect, Exit, Predicate, Queue, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import type { Header } from "./credential.js";

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

const isRequestId = Schema.is(Schema.Union([Schema.String, Schema.Number]));

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
  receivers: Map<string, Receiver>,
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

    // Why: the router does not tell a protocol the prefix it is mounted under, so two protocols
    // at one `path` would share their sockets' tags and answer each other's sockets.
    if (receivers.has(group)) {
      return yield* Effect.die(
        new Error(
          `Two ActionDurableObject.layerWebSocket protocols of one object serve the path ${options.path}: a router prefix does not tell them apart`,
        ),
      );
    }

    const disconnects = yield* Queue.make<number>();
    const awaitingExit = new Map<number, Map<RpcMessage.RequestId, Array<() => void>>>();

    const waitingOf = (clientId: number) => {
      const ofClient =
        awaitingExit.get(clientId) ?? new Map<RpcMessage.RequestId, Array<() => void>>();

      awaitingExit.set(clientId, ofClient);

      return ofClient;
    };

    const exited = (clientId: number, requestId: RpcMessage.RequestId) => {
      for (const resolve of awaitingExit.get(clientId)?.get(requestId) ?? []) resolve();
      awaitingExit.get(clientId)?.delete(requestId);
    };

    const allExited = (clientId: number) => {
      for (const waiting of awaitingExit.get(clientId)?.values() ?? []) {
        for (const resolve of waiting) resolve();
      }

      awaitingExit.delete(clientId);
    };

    // Why: a request the server refuses, such as one reusing an id in flight, ends its own wait
    // alone; ending every wait of its id would release the event of the request still running.
    const awaitExit = (clientId: number, requestId: RpcMessage.RequestId) => {
      const waiting = waitingOf(clientId);
      let settle = () => {};

      const exit = new Promise<void>((resolve) => {
        settle = resolve;
        waiting.set(requestId, [...(waiting.get(requestId) ?? []), resolve]);
      });

      return {
        exit,
        refused: () => {
          const others = (waiting.get(requestId) ?? []).filter((resolve) => resolve !== settle);

          if (others.length === 0) waiting.delete(requestId);
          else waiting.set(requestId, others);

          settle();
        },
      };
    };

    const sendTo = (clientId: number, response: RpcMessage.FromServerEncoded) => {
      const encoded = parser.encode(response);

      if (encoded === undefined) return;

      for (const socket of state.getWebSockets(tagOf(clientId))) socket.send(encoded);
    };

    const protocol = yield* RpcServer.Protocol.make((write) => {
      receivers.set(group, {
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

          const exits: Array<Promise<void>> = [];

          for (const message of messages) {
            // Why: registered before its own write, never earlier, so the exit of a request
            // already delivered under the same id cannot settle it. The server answers an id
            // that is neither a string nor a number with a defect alone, so none is awaited.
            const wait =
              isRequest(message) && isRequestId(message.id)
                ? awaitExit(clientId, RpcMessage.RequestId(message.id))
                : undefined;

            const written = await run(
              write(
                clientId,
                isRequest(message)
                  ? {
                      ...message,
                      headers: [...headers, ...message.headers],
                    }
                  : message,
              ).pipe(Effect.exit),
            );

            if (wait === undefined) continue;

            // Why: the server refuses a request whose id is in flight, or once the client ended,
            // and sends it no exit, which its message would otherwise wait for until the socket
            // closes.
            if (Exit.isFailure(written)) wait.refused();

            exits.push(wait.exit);
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

            // Why: only an exit ends a request. A defect, answering a frame the server cannot
            // read, leaves the client's other requests running, and each of them ends with its
            // exit: `ActionRpc.layer` disables fatal defects, so a handler's defect is one.
            if (Predicate.isTagged(response, "Exit")) {
              exited(clientId, RpcMessage.RequestId(response.requestId));
            }
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

        try {
          server.serializeAttachment(Attachment.make({ headers: options.saved(request) }));
        } catch {
          return HttpServerResponse.text(
            "The credential and the headers a socket keeps exceed its attachment",
            { status: 431 },
          );
        }

        state.acceptWebSocket(server, [group, tagOf(nextId++)]);

        return HttpServerResponse.raw(new Response(null, { status: 101, webSocket: client }), {
          status: 101,
        });
      }),
    );

    return protocol;
  });
