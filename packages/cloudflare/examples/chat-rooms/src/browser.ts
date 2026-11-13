import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect, Predicate, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LobbyHttp, RoomHttp } from "./Api.js";
import { MessagePosted } from "./chat/Chat.js";
import type { DemoRoomName } from "./chat/Chat.js";
import { PreviewsChanged } from "./lobby/Lobby.js";

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
                while: (error) => Predicate.isTagged(error, "HttpClientError"),
                times: 2,
              })
            )
        ),
      messages: (after: number) =>
        client.watch(MessagePosted, { room }, { cursor: String(after) }),
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

export const followLobby = (baseUrl: string) =>
  Effect.map(ActionHttp.client(LobbyHttp, { baseUrl }), (client) =>
    client.watch(PreviewsChanged, {}).pipe(
      Stream.filter((received) => Predicate.isTagged(received, "Occurrence")),
      Stream.map(({ data }) => data.previews)
    )
  );
