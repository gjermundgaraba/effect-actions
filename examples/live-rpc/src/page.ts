import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { RpcClient } from "effect/rpc";
import { Socket } from "effect/socket";
import { connection, openChat } from "./browser.js";

// The chat for a page that is not one Effect program: the same client, each call a promise.
// A `ManagedRuntime` keeps the protocol's layer, and so the socket, between calls. It builds
// the layer on the first call, which is when the socket opens, and `close` releases it. A
// failure `openChat` does not handle, such as `InvalidInput`, rejects the promise.
class Chat extends Context.Service<Chat, Effect.Success<typeof openChat>>()("live-rpc/Chat") {}

export const chatOver = <E>(protocol: Layer.Layer<RpcClient.Protocol, E>) => {
  const runtime = ManagedRuntime.make(Layer.effect(Chat, openChat).pipe(Layer.provide(protocol)));

  const call = <A, E2>(use: (chat: Chat["Service"]) => Effect.Effect<A, E2>) =>
    runtime.runPromise(Effect.flatMap(Chat, use));

  return {
    rooms: () => call((chat) => chat.rooms),

    room: (name: string, token: string) => ({
      read: (after: number) => call((chat) => chat.room(name, token).read(after)),
      post: (text: string) => call((chat) => chat.room(name, token).post(text)),
      remove: (id: number) => call((chat) => chat.room(name, token).remove(id)),
    }),

    close: () => runtime.dispose(),
  };
};

// What a page calls: `const chat = connect("wss://chat.example/rpc")`, on the browser's own
// WebSocket, then `await chat.room("lobby", token).post("Hello")`.
export const connect = (url: string) =>
  chatOver(connection(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)));
