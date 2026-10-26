import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Rpc } from "./app.js";

export const upgradeTo = (
  stub: DurableObjectStub,
  url: string,
  headers: Record<string, string> = {},
) =>
  Effect.promise(async () => {
    const response = await stub.fetch(url, { headers: { ...headers, upgrade: "websocket" } });

    const socket = response.webSocket;

    if (socket === null) throw new Error(`No WebSocket: ${response.status}`);

    socket.accept();

    return socket;
  });

export const upgradeToRpc = (stub: DurableObjectStub, headers: Record<string, string> = {}) =>
  upgradeTo(stub, "https://object/rpc", headers);

export const protocolOver = (socket: WebSocket) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.effect(Socket.Socket)(Socket.fromWebSocket(Effect.succeed(socket)))),
    Layer.provide(RpcSerialization.layerJson),
  );

export const protocolUpgrading = (stub: DurableObjectStub, headers: Record<string, string>) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.effect(Socket.Socket)(Socket.fromWebSocket(upgradeToRpc(stub, headers)))),
    Layer.provide(RpcSerialization.layerJson),
  );

export const scopedClientOver = (socket: WebSocket) =>
  Effect.flatMap(Layer.build(protocolOver(socket)), (protocol) =>
    ActionRpc.client(Rpc).pipe(Effect.provideContext(protocol)),
  );

export const nextMessage = (socket: WebSocket) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) =>
        socket.addEventListener("message", ({ data }) => resolve(String(data)), { once: true }),
      ),
  );
