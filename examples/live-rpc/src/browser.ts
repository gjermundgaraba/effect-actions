import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Layer, Stream } from "effect";
import { Headers } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { MessagePosted, roomHeader } from "./chat/Chat.js";
import { Rpc } from "./Rpc.js";

// Client module: what a web page imports. It holds the binding and nothing of the server, so a
// bundler gets the contracts and Effect's RPC client, no handler and nothing of Node.

// Effect's own client protocol: one WebSocket, speaking the server's JSON. This layer owns
// the socket, so a page provides it once, around its whole program, and every call shares
// that one socket. Which WebSocket is left to the host: a page provides
// `Socket.layerWebSocketConstructorGlobal`, the browser's own, and client.ts provides Node's.
export const connection = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(RpcSerialization.layerJson)
  );

// The chat as a page uses it, on the connection provided around it.
export const openChat = Effect.gen(function* () {
  // One typed method per action of the binding, all on the one connection.
  const client = yield* ActionRpc.client(Rpc);

  return {
    // The public rpc: no token.
    rooms: Effect.map(client.listRooms(), ({ rooms }) => rooms),

    room: (name: string, token: string) => {
      // A browser WebSocket cannot set an `Authorization` header on its upgrade, so the token
      // travels on each message, and the room beside it. A refreshed token needs no new socket.
      const headers = { authorization: `Bearer ${token}`, [roomHeader]: name };
      const here = RpcClient.withHeaders(headers);

      return {
        // What the room holds after the last id the page has. A token may expire while the
        // page stays open, so each refusal becomes what the page shows.
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

        // Each message posted to the room after the last id the page holds: a page opening a
        // room reads it, then watches from the last id it read, so a post between the two is
        // not lost; 0 sends the room's history first. `watch` connects again after a drop and
        // resumes from the last message it delivered, so the page never subscribes by hand; a
        // `Gap` says some were missed, or are another run's, so the page reads the room again
        // with `read(0)`. The headers go with the
        // stream, as `here` puts them on a call, and so with every request it sends again. A
        // refusal ends it, as when it connects again with a token that has expired.
        messages: (after: number) =>
          client
            .watch(MessagePosted, {}, { cursor: String(after) })
            .pipe(
              Stream.updateService(
                RpcClient.CurrentHeaders,
                Headers.merge(Headers.fromInput(headers))
              )
            ),

        // A declared error arrives as the contract's class. A message someone else already
        // removed is gone, which is what the page asked for.
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
