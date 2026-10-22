import { Effect, Layer, type Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import type { Message } from "./chat/Chat.js";
import { protocolVersion, RoomRpc, unsupportedProtocol } from "./Rpc.js";

// Client module: what a web page imports. It holds the binding and nothing of the server.

// Effect's own client protocol, one WebSocket to a room's object, speaking JSON: the socket's
// URL is `wss://<host>/rooms/<room>/rpc`, given the version of the rpcs the page was built
// with. A room serving another closes the socket at once with `unsupportedProtocol`, which
// fails every call and stream with a `SocketCloseError` of that code; `reconnectUntil` stops
// the client there, which Effect's own policy would not, connecting again every five seconds,
// each attempt waking the room's object: show "reload". The layer owns the socket, so provide it once, around the page's whole
// program; a page provides `Socket.layerWebSocketConstructorGlobal`, the browser's own
// WebSocket. The client pings every five seconds and the object's runtime answers, so a page
// left open does not wake the object.
export const connection = (url: string) =>
  RpcClient.layerProtocolSocket({
    retryPolicy: ActionRpc.reconnectUntil(unsupportedProtocol),
  }).pipe(
    Layer.provide(Socket.layerWebSocket(`${url}?protocol=${protocolVersion}`)),
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

    // The room's messages after `after`, then each as it is posted, told to `page` by
    // `ActionRpc.follow`: `opened` at the first message, each `message`, then `closed` with the
    // stream's exit, a refusal, the socket dropping, or a defect, such as a message the page
    // cannot decode; a page that stops following is told nothing. It ends after `closed`, and
    // never fails: what comes next is the page's. Effect's socket client fails every stream it
    // runs when its socket drops, so a page subscribes again, after a backoff of its choosing,
    // from the last message it holds; a message posted as it subscribes may arrive twice, and a
    // page drops an id it has seen.
    const follow = (
      after: number,
      page: ActionRpc.Following<Message, Stream.Error<ReturnType<typeof client.watch>>>,
    ) => ActionRpc.follow(client.watch({ after }, { headers }), page);

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
