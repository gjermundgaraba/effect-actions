import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { exports } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { protocolVersion, unsupportedProtocol } from "../../src/Rpc.js";

export const pageSocket = (
  at: string,
  headers: Record<string, string> = {},
  version = protocolVersion
) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(
      async () =>
        await exports.default.fetch(
          `https://chat.example${at}/rpc?protocol=${version}`,
          {
            headers: { ...headers, upgrade: "websocket" },
          }
        )
    );

    const socket = response.webSocket;

    if (socket === null) {
      return yield* Effect.die(new Error(`No WebSocket: ${response.status}`));
    }

    let connects = 0;

    const accepted = Effect.sync(() => {
      if (connects === 0) {
        socket.accept();
      }

      connects += 1;

      return socket;
    });

    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket({
        retryPolicy: ActionRpc.reconnectUntil(unsupportedProtocol),
      }).pipe(
        Layer.provide(
          Layer.effect(Socket.Socket)(Socket.fromWebSocket(accepted))
        ),
        Layer.provide(RpcSerialization.layerJson)
      )
    );

    return { socket, protocol, connects: () => connects };
  });

export const roomSocket = (
  room: string,
  headers: Record<string, string> = {},
  version = protocolVersion
) => pageSocket(`/rooms/${room}`, headers, version);
