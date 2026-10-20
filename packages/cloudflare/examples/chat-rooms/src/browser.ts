import { Effect, type Exit, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import type { Message } from "./chat/Chat.js";
import { RoomRpc } from "./Rpc.js";

// Client module: what a web page imports. It holds the binding and nothing of the server.

// A subscription's life, as a page renders it: `opened` at its first message, each `message`,
// then `closed` with how the stream ended. The exit is the stream's own: a refusal, the socket
// dropping, an interruption, or a defect, such as a message the page cannot decode, which a page
// watching only for failures would never see, left showing a subscription that ended.
export interface Following<E> {
  readonly opened: Effect.Effect<void>;
  readonly message: (message: Message) => Effect.Effect<void>;
  readonly closed: (exit: Exit.Exit<void, E>) => Effect.Effect<void>;
}

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

    // The room's messages after `after`, then each as it is posted, told to `page` as they
    // arrive. It ends when the stream does, after `closed`, and never fails: what comes next is
    // the page's. Effect's socket client fails every stream it runs when its socket drops, so a
    // page subscribes again, after a backoff of its choosing, from the last message it holds; a
    // message posted as it subscribes may arrive twice, and a page drops an id it has seen.
    const follow = (
      after: number,
      page: Following<Stream.Error<ReturnType<typeof client.watch>>>,
    ) =>
      client.watch({ after }, { headers }).pipe(
        Stream.onFirst(() => page.opened),
        Stream.runForEach(page.message),
        Effect.exit,
        Effect.flatMap(page.closed),
      );

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
