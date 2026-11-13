import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Layer, Predicate, Stream } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { LobbyHttp, RoomHttp } from "./Api.js";
import { MessagePosted } from "./chat/Chat.js";
import type { DemoRoomName } from "./chat/Chat.js";
import { PreviewsChanged } from "./lobby/Lobby.js";
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
      remove: (id: number) =>
        client.deleteMessage({ room, id }).pipe(
          Effect.as("removed" as const),
          Effect.catchTags({
            MessageNotFound: () => Effect.succeed("removed" as const),
            NotAuthor: () => Effect.succeed("not-yours" as const),
          })
        ),
    };
  });

export const followRoom = (room: DemoRoomName, token: string) =>
  Effect.map(
    ActionRpc.client(RoomRpc, { delivery: "poll" }),
    (client) => (after: number) =>
      client
        .watch(MessagePosted, { room }, { cursor: String(after) })
        .pipe(
          Stream.updateService(
            RpcClient.CurrentHeaders,
            Headers.merge(
              Headers.fromInput({ authorization: `Bearer ${token}` })
            )
          )
        )
  );

export const followLobby = (baseUrl: string) =>
  Effect.map(ActionHttp.client(LobbyHttp, { baseUrl }), (client) =>
    client.watch(PreviewsChanged, {}).pipe(
      Stream.filter((received) => Predicate.isTagged(received, "Occurrence")),
      Stream.map(({ data }) => data.previews)
    )
  );
