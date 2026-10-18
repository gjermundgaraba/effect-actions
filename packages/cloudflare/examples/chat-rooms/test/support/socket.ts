import { exports } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

// A page's socket to a room, upgraded through the Worker as a browser's would be. A test has no
// network to open one by its URL, so it hands the upgraded socket to Effect's client protocol,
// the protocol `connection(url)` builds over a URL.
export const roomSocket = (room: string, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      exports.default.fetch(`https://chat.example/rooms/${room}/rpc`, {
        headers: { ...headers, upgrade: "websocket" },
      }),
    );

    const socket = response.webSocket;

    if (socket === null) return yield* Effect.die(new Error(`No WebSocket: ${response.status}`));

    socket.accept();

    return yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.effect(Socket.Socket)(Socket.fromWebSocket(Effect.succeed(socket)))),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
  });
