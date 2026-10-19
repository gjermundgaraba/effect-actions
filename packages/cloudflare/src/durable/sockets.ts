import { Cause, Context, Effect, Exit, Predicate, Queue, Schema } from "effect";
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

const isHeaders = Schema.is(Schema.Array(Schema.Tuple([Schema.String, Schema.String])));

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
    const awaitingExit = new Map<number, Map<RpcMessage.RequestId, () => void>>();

    const waitingOf = (clientId: number) => {
      const ofClient = awaitingExit.get(clientId) ?? new Map<RpcMessage.RequestId, () => void>();

      awaitingExit.set(clientId, ofClient);

      return ofClient;
    };

    const exited = (clientId: number, requestId: RpcMessage.RequestId) => {
      awaitingExit.get(clientId)?.get(requestId)?.();
      awaitingExit.get(clientId)?.delete(requestId);
    };

    const allExited = (clientId: number) => {
      for (const resolve of awaitingExit.get(clientId)?.values() ?? []) resolve();

      awaitingExit.delete(clientId);
    };

    const awaitExit = (clientId: number, requestId: RpcMessage.RequestId) =>
      new Promise<void>((resolve) => {
        waitingOf(clientId).set(requestId, resolve);
      });

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
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- What a client sent: RpcServer checks each message's tag, id and payload; the adapter reads a request's id and headers through guards and writes in a suspended effect, so a malformed message fails alone and is answered with a defect.
            messages = parser.decode(
              Predicate.isString(data) ? data : new Uint8Array(data),
            ) as ReadonlyArray<RpcMessage.FromClientEncoded>;
          } catch (cause) {
            return sendTo(clientId, RpcMessage.ResponseDefectEncoded(encodeDefect(cause)));
          }

          const exits: Array<Promise<void>> = [];

          for (const message of messages) {
            // Why: checked here, not left to the server, which records a request before reading
            // its headers and keeps that record when they do not read: an interrupt under its id
            // would then be answered with an exit, ending the wait of another request.
            if (isRequest(message) && !isHeaders(message.headers)) {
              sendTo(
                clientId,
                RpcMessage.ResponseDefectEncoded(
                  encodeDefect(new Error("A request's headers are [name, value] pairs")),
                ),
              );

              continue;
            }

            const awaited =
              isRequest(message) && isRequestId(message.id)
                ? RpcMessage.RequestId(message.id)
                : undefined;

            // Why: a request reusing the id of one still running is dropped, as the server drops
            // a valid one. Written, a duplicate it answers before that check, such as one naming
            // no action, would end with an exit that also ends the running request's wait.
            if (awaited !== undefined && waitingOf(clientId).has(awaited)) continue;

            // Why: registered before its own write, never earlier, so the exit of a request
            // already delivered under the same id cannot settle it. The server answers an id
            // that is neither a string nor a number with a defect alone, so none is awaited.
            const exit = awaited === undefined ? undefined : awaitExit(clientId, awaited);

            // Why: suspended, so a message the server cannot read, such as `null`, fails alone
            // and is answered, and the frame still waits for the requests it already started.
            const written = await run(
              Effect.suspend(() =>
                write(
                  clientId,
                  isRequest(message)
                    ? { ...message, headers: [...headers, ...message.headers] }
                    : message,
                ),
              ).pipe(Effect.exit),
            );

            if (Exit.isFailure(written)) {
              // Why: a request whose write failed, refused by the server once its client ended or
              // never read, has no exit coming, which its message would otherwise wait for until
              // the socket closes.
              if (awaited !== undefined) exited(clientId, awaited);

              if (Cause.hasDies(written.cause)) {
                sendTo(
                  clientId,
                  RpcMessage.ResponseDefectEncoded(encodeDefect(Cause.squash(written.cause))),
                );
              }
            }

            if (exit !== undefined) exits.push(exit);
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
          Effect.withFiber((fiber) =>
            Effect.sync(() => {
              sendTo(clientId, response);

              // Why: only an exit ends a request. A defect, answering a frame the server cannot
              // read, leaves the client's other requests running, and each of them ends with its
              // exit: `ActionRpc.layer` disables fatal defects, so a handler's defect is one. The
              // wait ends with the fiber sending the exit, the request's own or one the server
              // forks for it, so the request's scope, its middleware's finalizers included, has
              // closed first.
              if (Predicate.isTagged(response, "Exit")) {
                fiber.addObserver(() => exited(clientId, RpcMessage.RequestId(response.requestId)));
              }
            }),
          ),
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
