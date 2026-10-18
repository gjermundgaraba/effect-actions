import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
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
    const signedIn = RpcClient.withHeaders({ authorization: `Bearer ${token}` });

    return {
      preview: Effect.map(client.preview(), ({ latest }) => latest),
      read: (after: number) =>
        Effect.map(client.readMessages({ after }).pipe(signedIn), ({ messages }) => messages),
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
