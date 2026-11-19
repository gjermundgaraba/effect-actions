import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Predicate, Stream } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient } from "effect/rpc";

import { RoomHttp } from "./Api.js";
import { MessagePosted } from "./chat/Chat.js";
import type { DemoRoomName } from "./chat/Chat.js";
import { protocolVersion, RoomRpc } from "./Rpc.js";

export const roomSocket = (
  baseUrl: string,
  room: DemoRoomName
): ActionRpc.SocketTarget => {
  const url = new URL(`/rooms/${room}/rpc`, baseUrl);

  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("protocol", protocolVersion);

  return { url: url.href };
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

export const followRoom = (
  socket: ActionRpc.SocketTarget,
  room: DemoRoomName,
  token: string
) =>
  Effect.map(
    ActionRpc.socketClient(RoomRpc, { ...socket, watchMode: "poll" }),
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
