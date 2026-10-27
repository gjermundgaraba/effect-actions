import type * as Event from "@gjermundgaraba/effect-actions/Event";
import { Context, Effect, Exit, Layer, ManagedRuntime, Stream } from "effect";
import type { RpcClient } from "effect/rpc";
import { Socket } from "effect/socket";

import { connection, openChat } from "./browser.js";
import type { MessagePosted } from "./chat/Chat.js";

// The chat for a page that is not one Effect program: the same client, each call a promise.
// A `ManagedRuntime` keeps the protocol's layer, and so the socket, between calls. It builds
// the layer on the first call, which is when the socket opens, and `close` releases it. A
// failure `openChat` does not handle, such as `InvalidInput`, rejects the promise.
class Chat extends Context.Service<Chat, Effect.Success<typeof openChat>>()(
  "live-rpc/Chat"
) {}

export const chatOver = <E>(protocol: Layer.Layer<RpcClient.Protocol, E>) => {
  const runtime = ManagedRuntime.make(
    Layer.effect(Chat, openChat).pipe(Layer.provide(protocol))
  );

  const call = async <A, E2>(
    use: (chat: Chat["Service"]) => Effect.Effect<A, E2>
  ) => await runtime.runPromise(Effect.flatMap(Chat, use));

  return {
    rooms: async () => await call((chat) => chat.rooms),

    room: (name: string, token: string) => ({
      read: async (after: number) =>
        await call((chat) => chat.room(name, token).read(after)),
      post: async (text: string) =>
        await call((chat) => chat.room(name, token).post(text)),
      remove: async (id: number) =>
        await call((chat) => chat.room(name, token).remove(id)),
      // Calls `receive` with each message posted after `after`, the id of the last message the
      // page holds, and each gap, as `messages` streams them, until the page calls the function
      // it returns. `ended` is told why it stopped: a refusal, such as a token that expired by
      // the time the watch connected again, or anything else, the page's own call included.
      watch: (
        after: number,
        receive: (received: Event.Received<typeof MessagePosted>) => void,
        ended: (why: "signed-out" | "not-a-member" | "stopped") => void
      ) =>
        runtime.runCallback(
          Effect.flatMap(Chat, (chat) =>
            Stream.runForEach(
              chat.room(name, token).messages(after),
              (received) =>
                Effect.sync(() => {
                  receive(received);
                })
            )
          ).pipe(
            Effect.as("stopped" as const),
            Effect.catchTags({
              Unauthenticated: () => Effect.succeed("signed-out" as const),
              Forbidden: () => Effect.succeed("not-a-member" as const),
            })
          ),
          {
            onExit: (exit) => {
              ended(Exit.isSuccess(exit) ? exit.value : "stopped");
            },
          }
        ),
    }),

    close: async () => {
      await runtime.dispose();
    },
  };
};

// What a page calls: `const chat = connect("wss://chat.example/rpc")`, on the browser's own
// WebSocket, then `await chat.room("lobby", token).post("Hello")`.
export const connect = (url: string) =>
  chatOver(
    connection(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
  );
