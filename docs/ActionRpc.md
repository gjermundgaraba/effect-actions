# ActionRpc

Actions as Effect RPC, on Effect's own `RpcServer` and `RpcClient`: one unary rpc per action.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [ActionRpc-failures.md](ActionRpc-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot show.

## Bind actions to rpcs

A binding that holds a protected action names its authentication descriptor
([Authentication.md](Authentication.md#declare-how-callers-sign-in)); the rules of each option
are on `ActionRpc.Options`. Call `ActionRpc.make` once and export the binding:

```ts example=live-rpc/src/Rpc.ts
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { ListRooms, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

// The RPC binding: one native rpc per action, named after it, the protected ones requiring
// `Login`. It is plain data and imports no server code, so the server and a browser page both
// import this one value. `Rpc.group` is the native `RpcGroup`, for Effect's own `RpcClient.make`.
export const Rpc = ActionRpc.make([ListRooms, ...Messages], { authentication: Login });
```

[kitchen-sink/src/Rpc.ts](../examples/kitchen-sink/src/Rpc.ts) adds `error`, what its
middleware fails with.

## Serve the rpcs

In the routes file, give `ActionRpc.layer` the binding and the implementations, and provide
what it requires except the protocol and the startup services the entrypoint chooses: the
service of each listed middleware and, where it serves a protected action, the authentication
provider ([Authentication.md](Authentication.md#verify-credentials)).

```ts example=live-rpc/src/routes.ts
import { Layer } from "effect";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { messages, rooms } from "./chat/handlers.js";
import { ResolveRoom, resolveRoom } from "./chat/room.js";
import { authenticate } from "./identity/verifier.js";
import { Rpc } from "./Rpc.js";

// The binding's rpcs on Effect's own RpcServer, the protected ones behind `Login`'s verifier;
// `listRooms` needs no token.
//
// `ResolveRoom`, listed in `middleware`, provides `CurrentRoom`, which the handlers and
// `authorize` read. Only something that runs per message can, since each message names its own
// room: `Layer.succeed(CurrentRoom, "lobby")` provided here would leave the layer still
// requiring it, in its type.
//
// It still requires three things, each chosen by whoever serves it. The protocol and its
// serialization: server.ts gives it a WebSocket, and a test Effect's HTTP protocol, which
// answers in memory. And `MessageStore`.
export const rpc = ActionRpc.layer(Rpc, [rooms, messages], { middleware: [ResolveRoom] }).pipe(
  Layer.provide([resolveRoom, authenticate]),
);
```

The entrypoint serves the result with `HttpRouter.serve`; a test serves it in memory
([Testing.md](Testing.md#test-rpcs)).

```ts example=live-rpc/src/server.ts
import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { MessageStore } from "./chat/store.js";
import { rpc } from "./routes.js";

// Entrypoint: `node --import tsx examples/live-rpc/src/server.ts`.
// It chooses the protocol, the store and the port, and starts Node's HTTP server. It provides
// no caller and no room: those arrive with each message.

// The rpcs over a WebSocket at `/rpc`, the router's one route: Node's HTTP server answers the
// upgrade. JSON, because a page's client speaks it: browser.ts gives its socket the same
// serialization.
const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);

const server = Layer.unwrap(
  Effect.gen(function* () {
    // The loopback default serves this machine alone; HOST=0.0.0.0 lets others reach it.
    const host = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    return HttpRouter.serve(socket).pipe(
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host,
          port,
          // A message on a WebSocket is no request body, so `HttpServerRequest.MaxBodySize`
          // does not bound it: Node's WebSocket server reads one of up to 100 MiB whole unless
          // told otherwise. A chat message is short, and a larger one closes the socket (1009).
          websocket: { maxPayload: 64 * 1024 },
        }),
      ),
      // DEMO ONLY: messages live in this process's memory; a deployment provides a store that
      // lasts.
      Layer.provide(MessageStore.layerMemory),
    );
  }),
);

Layer.launch(server).pipe(NodeRuntime.runMain);
```

Where the protocol goes, why one protocol takes one layer, and what a protocol with no router
lacks are on `ActionRpc.layer`; the order of `middleware`, and which actions a middleware
reading the identity may serve, on `ActionRpc.LayerOptions.middleware`.
[kitchen-sink/src/identity/quota.ts](../examples/kitchen-sink/src/identity/quota.ts) is a limit
in `middleware`, keyed on the caller, and
[kitchen-sink/src/Rpc.ts](../examples/kitchen-sink/src/Rpc.ts) binds the protected actions
alone for it.

- **On Cloudflare Workers.** `RpcServer.layerProtocolWebsocket` cannot upgrade a request there:
  serve the rpcs from a Durable Object with `@gjermundgaraba/effect-actions-cloudflare`, whose
  sockets hibernate.
- **The same actions as JSON too.** Merge `ActionHttp.layer(Http, implementations)` beside the
  rpc layer, each given its descriptor's provider
  ([kitchen-sink/src/routes.ts](../examples/kitchen-sink/src/routes.ts) defines both, and
  [server.ts](../examples/kitchen-sink/src/server.ts) merges them): one provider given to both
  is built once. The routes need what the rpcs did not: an `httpApiStatus` on a declared error,
  by the rule on `Action.Options.error`, and router middleware for a service an `RpcMiddleware`
  provides ([ActionHttp.md](ActionHttp.md#serve-the-routes)).

## Call the rpcs

`ActionRpc.client(Rpc)` has the methods of `ActionHttp.client`
([ActionHttp.md](ActionHttp.md#call-the-api-from-effect)), and what one call fails with is
`ActionRpc.MethodError`. A page's client module:

```ts example=live-rpc/src/browser.ts
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { roomHeader } from "./chat/Chat.js";
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
      const here = RpcClient.withHeaders({ authorization: `Bearer ${token}`, [roomHeader]: name });

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
```

[live-rpc/src/client.ts](../examples/live-rpc/src/client.ts) runs it from Node, and
[live-rpc/src/page.ts](../examples/live-rpc/src/page.ts) wraps it in promises for a page that is
not one Effect program. The client's traps are on `ActionRpc.client`.

## Send request context with a call

What travels beside a call's input, such as a token, a tenant or a room, goes in headers: the
client wraps the call in `RpcClient.withHeaders`, as `room` does in `browser.ts` above. On the
server, authentication decodes the credential from those headers. Anything else is read by
native `RpcMiddleware` listed in `ActionRpc.layer`'s `middleware`:

```ts example=live-rpc/src/chat/room.ts
import { Context, Effect, Layer } from "effect";
import { RpcMiddleware } from "effect/rpc";
import { defaultRoom, roomHeader } from "./Chat.js";

/**
 * The room a message is about. A request-time service: handlers and `authorize` read it per
 * call, and it has no Layer, because no one value of it is right for a whole server.
 */
export class CurrentRoom extends Context.Service<CurrentRoom, string>()("live-rpc/CurrentRoom") {}

// Native Effect RPC middleware, declared as providing `CurrentRoom`. Listed in
// `ActionRpc.layer`'s `middleware`, it runs once per message.
export class ResolveRoom extends RpcMiddleware.Service<ResolveRoom, { provides: CurrentRoom }>()(
  "live-rpc/ResolveRoom",
) {}

// The middleware's implementation. It gets the message's headers, which over a WebSocket are
// the upgrade request's merged with the message's own, and runs the rest of the call with the
// room they name, or the default room when they name none. It refuses nothing: whether the
// caller may be in that room is `authorize`'s rule.
export const resolveRoom = Layer.succeed(ResolveRoom, (call, { headers }) =>
  Effect.provideService(call, CurrentRoom, headers[roomHeader] ?? defaultRoom),
);
```

Why router middleware is no substitute over a WebSocket is on
`ActionRpc.LayerOptions.middleware`.

- **A cookie the browser attaches to the upgrade covers every message**
  ([kitchen-sink/src/browser.ts](../examples/kitchen-sink/src/browser.ts)). A browser attaches
  it from any page, so refuse a foreign `Origin` on the upgrade, with a request policy
  ([Authentication-advanced.md](Authentication-advanced.md#run-a-request-policy-before-authentication)).
