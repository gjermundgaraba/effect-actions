import { exports } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { protocolVersion, unsupportedProtocol } from "../../src/Rpc.js";

// A page's socket to a room, upgraded through the Worker as a browser's would be, naming the
// version of the rpcs as `connection(url)` does. A test has no network to open one by its URL,
// so it hands the upgraded socket to Effect's client protocol, the protocol `connection(url)`
// builds over a URL, its reconnection included, and keeps the socket, which a test listens on
// for what the object sent. The socket is accepted as Effect's client listens to it, as a
// browser's socket is constructed with its listeners: accepted before, a close the room sent
// at once could go unheard. `connects` counts the client's attempts: each after the first
// would be another upgrade in a browser.
export const roomSocket = (
  room: string,
  headers: Record<string, string> = {},
  version = protocolVersion,
) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      exports.default.fetch(`https://chat.example/rooms/${room}/rpc?protocol=${version}`, {
        headers: { ...headers, upgrade: "websocket" },
      }),
    );

    const socket = response.webSocket;

    if (socket === null) return yield* Effect.die(new Error(`No WebSocket: ${response.status}`));

    let connects = 0;

    const accepted = Effect.sync(() => {
      if (connects++ === 0) socket.accept();

      return socket;
    });

    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket({
        retryPolicy: ActionRpc.reconnectUntil(unsupportedProtocol),
      }).pipe(
        Layer.provide(Layer.effect(Socket.Socket)(Socket.fromWebSocket(accepted))),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );

    return { socket, protocol, connects: () => connects };
  });
