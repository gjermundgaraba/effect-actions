import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Layer, Predicate, Stream } from "effect";
import { Headers } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { MessagePosted } from "./chat/Chat.js";
import type { DemoRoomName } from "./chat/Chat.js";
import { PreviewsChanged } from "./lobby/Lobby.js";
import {
  LobbyRpc,
  protocolVersion,
  RoomRpc,
  unsupportedProtocol,
} from "./Rpc.js";

export const connection = (url: string) =>
  RpcClient.layerProtocolSocket({
    retryPolicy: ActionRpc.reconnectUntil(unsupportedProtocol),
  }).pipe(
    Layer.provide(Socket.layerWebSocket(`${url}?protocol=${protocolVersion}`)),
    Layer.provide(RpcSerialization.layerJson)
  );

export const openRoom = (room: DemoRoomName, token: string) =>
  Effect.gen(function* () {
    const client = yield* ActionRpc.client(RoomRpc);
    const headers = { authorization: `Bearer ${token}` };
    const signedIn = RpcClient.withHeaders(headers);

    return {
      read: (after: number) =>
        client.readMessages({ room, after }).pipe(
          signedIn,
          Effect.map(({ messages }) => messages)
        ),
      post: (text: string) =>
        Effect.flatMap(
          Effect.sync(() => crypto.randomUUID()),
          (request) =>
            client.postMessage({ room, text, request }).pipe(
              signedIn,
              Effect.retry({
                while: (error) => Predicate.isTagged(error, "RpcClientError"),
                times: 2,
              })
            )
        ),
      messages: (after: number) =>
        client
          .watch(MessagePosted, { room }, { cursor: String(after) })
          .pipe(
            Stream.updateService(
              RpcClient.CurrentHeaders,
              Headers.merge(Headers.fromInput(headers))
            )
          ),
      remove: (id: number) =>
        client.deleteMessage({ room, id }).pipe(
          signedIn,
          Effect.as("removed" as const),
          Effect.catchTags({
            MessageNotFound: () => Effect.succeed("removed" as const),
            NotAuthor: () => Effect.succeed("not-yours" as const),
          })
        ),
    };
  });

export const followLobby = Effect.map(ActionRpc.client(LobbyRpc), (client) =>
  client.watch(PreviewsChanged, {}).pipe(
    Stream.filter((received) => Predicate.isTagged(received, "Occurrence")),
    Stream.map(({ data }) => data.previews)
  )
);
