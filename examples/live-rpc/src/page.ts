import type * as Event from "@gjermundgaraba/effect-actions/Event";
import { Context, Effect, Exit, Layer, ManagedRuntime, Stream } from "effect";
import type { RpcClient } from "effect/rpc";
import { Socket } from "effect/socket";

import { connection, openChat } from "./browser.js";
import type { MessagePosted } from "./chat/Chat.js";

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

export const connect = (url: string) =>
  chatOver(
    connection(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
  );
