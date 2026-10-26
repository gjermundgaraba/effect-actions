import { Effect, Layer, Predicate, Stream } from "effect";
import { Headers } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { MessagePosted, type RoomName } from "./chat/Chat.js";
import { PreviewsChanged } from "./lobby/Lobby.js";
import { LobbyRpc, protocolVersion, RoomRpc, unsupportedProtocol } from "./Rpc.js";

// Client module: what a web page imports. It holds the binding and nothing of the server.

// Effect's own client protocol, one WebSocket to an object, speaking JSON: the socket's URL is
// `wss://<host>/rooms/<room>/rpc` for a room and `wss://<host>/lobby/rpc` for the lobby, given the version of the rpcs the page was built
// with. An object serving another closes the socket at once with `unsupportedProtocol`, which
// fails every call and stream with a `SocketCloseError` of that code; `reconnectUntil` stops
// the client there, which Effect's own policy would not, connecting again every five seconds,
// each attempt waking the object: show "reload". The layer owns the socket, so provide it
// once, around the page's whole program; a page provides `Socket.layerWebSocketConstructorGlobal`, the browser's own
// WebSocket. The client pings every five seconds and the object's runtime answers, so a page
// left open does not wake the object.
export const connection = (url: string) =>
  RpcClient.layerProtocolSocket({
    retryPolicy: ActionRpc.reconnectUntil(unsupportedProtocol),
  }).pipe(
    Layer.provide(Socket.layerWebSocket(`${url}?protocol=${protocolVersion}`)),
    Layer.provide(RpcSerialization.layerJson),
  );

// A room as a page uses it, over the socket to that room's object: each call names the room, as
// every call of a room does, and the object refuses one naming another. A browser WebSocket sets
// no header when it connects, so the token travels on each message; a client that can set headers
// on the upgrade, such as a Worker or a native app, sends it once there, and the socket keeps it.
export const openRoom = (room: RoomName, token: string) =>
  Effect.gen(function* () {
    const client = yield* ActionRpc.client(RoomRpc);
    const headers = { authorization: `Bearer ${token}` };
    const signedIn = RpcClient.withHeaders(headers);

    return {
      // The room's messages after `after`, the id of the last one the page holds: 0 reads them
      // all.
      read: (after: number) =>
        client.readMessages({ room, after }).pipe(
          signedIn,
          Effect.map(({ messages }) => messages),
        ),
      // A post the socket lost, as the room's object restarted, fails with an `RpcClientError`,
      // whether or not it reached the room: sent again with its `request`, made once for the
      // message, it is posted once.
      post: (text: string) =>
        Effect.flatMap(
          Effect.sync(() => crypto.randomUUID()),
          (request) =>
            client.postMessage({ room, text, request }).pipe(
              signedIn,
              Effect.retry({
                while: (error) => Predicate.isTagged(error, "RpcClientError"),
                times: 2,
              }),
            ),
        ),
      // Each message posted to the room after `after`, the id of the last one the page holds: a
      // page opening the room reads it, then watches from the last id it read, so a post between
      // the two is not lost. The room's object keeps the watch while it hibernates, and resumes it
      // when it next wakes, authenticating its token again: a token that expired meanwhile ends
      // the watch with `Unauthenticated`, so watch again with a fresh one. `watch` connects again
      // after a drop and resumes from the last message it delivered; a `Gap` says some were
      // missed, which the page reads with `read`. The headers go with the stream, as `signedIn`
      // puts them on a call, and so with every request it sends again.
      messages: (after: number) =>
        client
          .watch(MessagePosted, { room }, { cursor: String(after) })
          .pipe(
            Stream.updateService(
              RpcClient.CurrentHeaders,
              Headers.merge(Headers.fromInput(headers)),
            ),
          ),
      remove: (id: number) =>
        client.deleteMessage({ room, id }).pipe(
          signedIn,
          Effect.as("removed" as const),
          Effect.catchTags({
            MessageNotFound: () => Effect.succeed("removed" as const),
            NotAuthor: () => Effect.succeed("not-yours" as const),
          }),
        ),
    };
  });

// The lobby as a page follows it, signed in or not: every room's preview, first as it is, then
// whole again at each change. A watch given no cursor starts with the previews, so the page reads
// nothing first; after a drop it resumes from the last it received, and hears the previews again
// only if they changed meanwhile. A `Gap` needs no read either: the next occurrence is whole.
export const followLobby = Effect.map(ActionRpc.client(LobbyRpc), (client) =>
  client.watch(PreviewsChanged, {}).pipe(
    Stream.filter((received) => Predicate.isTagged(received, "Occurrence")),
    Stream.map(({ data }) => data.previews),
  ),
);
