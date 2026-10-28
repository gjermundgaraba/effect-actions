import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Layer, Stream } from "effect";
import { Headers } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { MessagePosted, roomHeader } from "./chat/Chat.js";
import { Rpc } from "./Rpc.js";

export const connection = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(RpcSerialization.layerJson)
  );

export const openChat = Effect.gen(function* () {
  const client = yield* ActionRpc.client(Rpc);

  return {
    rooms: Effect.map(client.listRooms(), ({ rooms }) => rooms),

    room: (name: string, token: string) => {
      const headers = { authorization: `Bearer ${token}`, [roomHeader]: name };
      const here = RpcClient.withHeaders(headers);

      return {
        read: (after: number) =>
          client.readMessages({ after }).pipe(
            here,
            Effect.map(({ messages }) => ({
              access: "member" as const,
              messages,
            })),
            Effect.catchTags({
              Unauthenticated: () =>
                Effect.succeed({ access: "signed-out" as const, messages: [] }),
              Forbidden: () =>
                Effect.succeed({
                  access: "not-a-member" as const,
                  messages: [],
                }),
            })
          ),

        post: (text: string) => client.postMessage({ text }).pipe(here),

        messages: (after: number) =>
          client
            .watch(MessagePosted, {}, { cursor: String(after) })
            .pipe(
              Stream.updateService(
                RpcClient.CurrentHeaders,
                Headers.merge(Headers.fromInput(headers))
              )
            ),

        remove: (id: number) =>
          client.deleteMessage({ id }).pipe(
            here,
            Effect.as("removed" as const),
            Effect.catchTags({
              MessageNotFound: () => Effect.succeed("removed" as const),
              NotAuthor: () => Effect.succeed("not-yours" as const),
            })
          ),
      };
    },
  };
});
