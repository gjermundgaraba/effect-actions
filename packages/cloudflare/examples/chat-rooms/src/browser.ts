import { Effect, Layer, Predicate, Schedule, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import type { Message } from "./chat/Chat.js";
import { RoomRpc } from "./Rpc.js";

// Client module: what a web page imports. It holds the binding and nothing of the server.

// Effect's own client protocol, one WebSocket to a room's object, speaking JSON: the socket's
// URL is `wss://<host>/rooms/<room>/rpc`. The layer owns the socket, so provide it once, around
// the page's whole program; a page provides `Socket.layerWebSocketConstructorGlobal`, the
// browser's own WebSocket. The client pings every five seconds and the object's runtime
// answers, so a page left open does not wake the object.
export const connection = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(RpcSerialization.layerJson),
  );

// A room as a page uses it. A browser WebSocket sets no header when it connects, so the token
// travels on each message; a client that can set headers on the upgrade, such as a Worker or a
// native app, sends it once there, and the socket keeps it.
export const openRoom = (token: string) =>
  Effect.gen(function* () {
    const client = yield* ActionRpc.client(RoomRpc);
    const headers = { authorization: `Bearer ${token}` };
    const signedIn = RpcClient.withHeaders(headers);

    // The room's messages after `after`, then each as it is posted, rendered in order. Effect's
    // socket client fails every stream it runs when its socket drops, so this subscribes again,
    // a second later, from the last message rendered; a refusal ends it. A message posted as the
    // page subscribes may arrive twice, and is rendered once.
    const follow = (after: number, render: (message: Message) => Effect.Effect<void>) =>
      Effect.suspend(() => {
        let lastSeen = after;

        return Effect.suspend(() =>
          client.watch({ after: lastSeen }, { headers }).pipe(
            Stream.filter((message) => message.id > lastSeen),
            Stream.runForEach((message) => {
              lastSeen = message.id;

              return render(message);
            }),
          ),
        ).pipe(
          Effect.retry({
            while: (error) => Predicate.isTagged(error, "RpcClientError"),
            schedule: Schedule.spaced("1 second"),
          }),
        );
      });

    return {
      preview: Effect.map(client.preview(), ({ latestAt }) => latestAt),
      follow,
      post: (text: string) => client.postMessage({ text }).pipe(signedIn),
      remove: (id: number) =>
        client.deleteMessage({ id }).pipe(
          signedIn,
          Effect.as("removed" as const),
          Effect.catchTags({
            MessageNotFound: () => Effect.succeed("removed" as const),
            NotAuthor: () => Effect.succeed("not-yours" as const),
          }),
        ),
    };
  });
