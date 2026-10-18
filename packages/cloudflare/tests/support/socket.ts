import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Rpc } from "./app.js";

export const upgradeToRpc = (stub: DurableObjectStub, headers: Record<string, string> = {}) =>
  Effect.promise(async () => {
    const response = await stub.fetch("https://object/rpc", {
      headers: { ...headers, upgrade: "websocket" },
    });

    const socket = response.webSocket;

    if (socket === null) throw new Error(`No WebSocket: ${response.status}`);

    socket.accept();

    return socket;
  });

export const scopedClientOver = (socket: WebSocket) =>
  Effect.flatMap(
    Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.effect(Socket.Socket)(Socket.fromWebSocket(Effect.succeed(socket)))),
        Layer.provide(RpcSerialization.layerJson),
      ),
    ),
    (protocol) => ActionRpc.client(Rpc).pipe(Effect.provideContext(protocol)),
  );
