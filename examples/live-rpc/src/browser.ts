import { Effect, Layer } from "effect";
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
//
// A page that is not one Effect program keeps the layer in a runtime:
// `ManagedRuntime.make(connection(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)))`,
// each call through `runtime.runPromise`, and `runtime.dispose()` to close the socket.
export const connection = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(RpcSerialization.layerJson),
  );

// The chat as a page uses it, on the connection provided around it. The scope it needs holds
// only the typed client built on that connection, not the socket.
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
