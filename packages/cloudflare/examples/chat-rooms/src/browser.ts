import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Layer, Predicate, Stream } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { RoomHttp } from "./Api.js";
import { MessagePosted } from "./chat/Chat.js";
import type { DemoRoomName } from "./chat/Chat.js";
import { protocolVersion, RoomRpc, unsupportedProtocol } from "./Rpc.js";

export const overSocket = RpcClient.layerProtocolSocket({
  retryPolicy: ActionRpc.reconnectUntil(unsupportedProtocol),
}).pipe(Layer.provide(RpcSerialization.layerJson));

export const roomConnection = (baseUrl: string, room: DemoRoomName) => {
  const url = new URL(`/rooms/${room}/rpc`, baseUrl);

  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("protocol", protocolVersion);

  return overSocket.pipe(
    Layer.provide(Socket.layerWebSocket(url.href)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal)
  );
};

export const openRoom = (baseUrl: string, room: DemoRoomName, token: string) =>
  Effect.gen(function* () {
    const client = yield* ActionHttp.client(RoomHttp, {
      baseUrl,
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.bearerToken(token)
      ),
    });

    return {
      read: (after: number) =>
        Effect.map(
          client.readMessages({ room, after }),
          ({ messages }) => messages
        ),
      post: (text: string) =>
        Effect.flatMap(
          Effect.sync(() => crypto.randomUUID()),
          (request) =>
            client.postMessage({ room, text, request }).pipe(
              Effect.retry({
                while: (error) =>
                  Predicate.isTagged(error, "HttpClientError") &&
                  error.reason._tag === "TransportError",
                times: 2,
              })
            )
        ),
    };
  });

export const followRoom = (room: DemoRoomName, token: string) =>
  Effect.map(
    ActionRpc.client(RoomRpc),
    (client) => (after: number) =>
      client
        .watch(MessagePosted, { room }, { cursor: String(after), mode: "poll" })
        .pipe(
          Stream.updateService(
            RpcClient.CurrentHeaders,
            Headers.merge(
              Headers.fromInput({ authorization: `Bearer ${token}` })
            )
          )
        )
  );
