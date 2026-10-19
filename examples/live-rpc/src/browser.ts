import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { roomHeader } from "./chat/Chat.js";
import { Rpc } from "./Rpc.js";

// Client module: what a web page imports. It holds the binding and nothing of the server, so a
// bundler gets the contracts and Effect's RPC client, no handler and nothing of Node.

// Effect's own client protocol: one WebSocket, speaking the server's JSON. This layer owns
// the socket: it opens when the layer is built and closes when the layer is released, so
// provide it once, around the page's whole program, never around one call. Which WebSocket is
// left to the host: a page provides `Socket.layerWebSocketConstructorGlobal`, the browser's
// own, and client.ts provides Node's.
export const connection = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(RpcSerialization.layerJson),
  );

// The chat as a page uses it, on the connection provided around it.
export const openChat = Effect.gen(function* () {
  // One typed method per action of the binding, all on the one connection.
  const client = yield* ActionRpc.client(Rpc);

  return {
    // The public rpc: no token.
    rooms: Effect.map(client.listRooms(), ({ rooms }) => rooms),

    room: (name: string, token: string) => {
      // A browser WebSocket sets no header when it connects, so the token travels on each
      // message, and the room beside it. A refreshed token needs no new socket.
      const here = RpcClient.withHeaders({ authorization: `Bearer ${token}`, [roomHeader]: name });

      return {
        // Called again and again while the page is open, with the last id it holds. A token
        // may expire under a socket that stays up, so the refusals are handled here. Each is
        // a typed failure matched by its tag, and only that call fails: the socket stays open.
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
