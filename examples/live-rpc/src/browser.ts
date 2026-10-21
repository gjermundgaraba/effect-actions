import { Effect, type Exit, Layer, Predicate, Ref, Schedule, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { type Message, roomHeader } from "./chat/Chat.js";
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
    Layer.provide(RpcSerialization.layerJson),
  );

// A room followed, as a page renders it: `opened` at a subscription's first message, each
// `message`, then `closed` with how following ended: a refusal, or a defect, such as a message
// the page cannot decode, which a page watching only for failures would never see.
export interface Following<E> {
  readonly opened: Effect.Effect<void>;
  readonly message: (message: Message) => Effect.Effect<void>;
  readonly closed: (exit: Exit.Exit<void, E>) => Effect.Effect<void>;
}

// How long a page waits before it subscribes again, longer each time, at most ten seconds.
const backoff = Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("10 seconds")]);

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
        // Called again and again while the page is open, with the last id it holds. A token
        // may expire while the page stays open, so each refusal becomes what the page shows.
        read: (after: number) =>
          client.readMessages({ after }).pipe(
            here,
            Effect.map(({ messages }) => ({ access: "member" as const, messages })),
            Effect.catchTags({
              Unauthenticated: () =>
                Effect.succeed({ access: "signed-out" as const, messages: [] }),
              Forbidden: () => Effect.succeed({ access: "not-a-member" as const, messages: [] }),
            }),
          ),

        post: (text: string) => client.postMessage({ text }).pipe(here),

        // The room's messages after `after`, then each one posted, told to `page`. Effect's
        // socket client fails every stream it runs with `RpcClientError` when its socket drops,
        // and connects again by itself, so the page subscribes again after a backoff, from the
        // last message it holds, until a refusal or a defect ends it. A message posted as it
        // subscribes may arrive twice: the page drops an id it holds.
        follow: (after: number, page: Following<Stream.Error<ReturnType<typeof client.watch>>>) =>
          Effect.gen(function* () {
            const last = yield* Ref.make(after);

            const subscribe = Effect.flatMap(Ref.get(last), (from) =>
              client.watch({ after: from }, { headers }).pipe(
                Stream.onFirst(() => page.opened),
                Stream.runForEach((message) =>
                  Effect.andThen(Ref.set(last, message.id), page.message(message)),
                ),
              ),
            );

            const exit = yield* subscribe.pipe(
              Effect.retry(($) =>
                $(backoff).pipe(
                  Schedule.while(({ input }) => Predicate.isTagged(input, "RpcClientError")),
                ),
              ),
              Effect.exit,
            );

            yield* page.closed(exit);
          }),

        // A declared error arrives as the contract's class. A message someone else already
        // removed is gone, which is what the page asked for.
        remove: (id: number) =>
          client.deleteMessage({ id }).pipe(
            here,
            Effect.as("removed" as const),
            Effect.catchTags({
              MessageNotFound: () => Effect.succeed("removed" as const),
              NotAuthor: () => Effect.succeed("not-yours" as const),
            }),
          ),
      };
    },
  };
});
