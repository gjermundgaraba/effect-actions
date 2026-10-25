# ActionRpc

Actions as Effect RPC, on Effect's own `RpcServer` and `RpcClient`: one rpc per action, a stream
rpc per event type, and native rpcs of your own beside them.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [ActionRpc-failures.md](ActionRpc-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot show.

## Bind actions to rpcs

A binding that holds a protected action names its authentication descriptor
([Authentication.md](Authentication.md#declare-how-callers-sign-in)); the rules of each option
are on `ActionRpc.Options`. Call `ActionRpc.make` once and export the binding:

```ts example=live-rpc/src/Rpc.ts
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { ListRooms, MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

// The RPC binding: one native rpc per action, named after it, and a stream rpc for
// `MessagePosted`, the protected ones requiring `Login`. It is plain data and imports no server
// code, so the server and a browser page both import this one value. `Rpc.group` is the native
// `RpcGroup`, for Effect's own `RpcClient.make`.
export const Rpc = ActionRpc.make([ListRooms, ...Messages, MessagePosted], {
  authentication: Login,
});
```

[kitchen-sink/src/Rpc.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Rpc.ts) adds `error`, what its
middleware fails with.

## Serve the rpcs

In the routes file, give `ActionRpc.layer` the binding and the implementations, and provide
what it requires except the protocol and the startup services the entrypoint chooses: the
service of each listed middleware and, where it serves a protected action, the authentication
provider ([Authentication.md](Authentication.md#verify-credentials)).

```ts example=live-rpc/src/routes.ts
import { Layer } from "effect";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { messageEvents } from "./chat/events.js";
import { messages, rooms } from "./chat/handlers.js";
import { ResolveRoom, resolveRoom } from "./chat/room.js";
import { authenticate } from "./identity/verifier.js";
import { Rpc } from "./Rpc.js";

// The binding's rpcs on Effect's own RpcServer, the protected ones behind `Login`'s verifier;
// `listRooms` needs no token.
//
// `ResolveRoom`, listed in `middleware`, provides `CurrentRoom`, which the handlers, the event's
// source and `authorize` read; on a watch it runs as the watch starts, and each time it connects
// again. Only something that runs per message can, since each message names its own room:
// `Layer.succeed(CurrentRoom, "lobby")` provided here would leave the layer still requiring it,
// in its type.
//
// It still requires four things, each chosen by whoever serves it. The protocol and its
// serialization: server.ts gives it a WebSocket, and a test Effect's HTTP protocol, which
// answers in memory. `MessageStore`, and `Event.Events`, which `postMessage` notifies and the
// watches wait on: one of each, provided around the whole server.
export const rpc = ActionRpc.layer(Rpc, [rooms, messages, messageEvents], {
  middleware: [ResolveRoom],
}).pipe(Layer.provide([resolveRoom, authenticate]));
```

The entrypoint serves the result with `HttpRouter.serve`; a test serves it in memory
([Testing.md](Testing.md#test-rpcs)).

```ts example=live-rpc/src/server.ts
import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import * as Event from "@gjermundgaraba/effect-actions/Event";
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
      // The pages watching a room are this process's sockets, so what wakes them lives in its
      // memory too: one for the whole server. Several processes behind a balancer would each
      // wake only their own pages, the others reading a post at their next read, 5 seconds on.
      Layer.provide(Event.layerMemory),
    );
  }),
);

Layer.launch(server).pipe(NodeRuntime.runMain);
```

Where the protocol goes, why one protocol takes one layer, and what a protocol with no router
lacks are on `ActionRpc.layer`; the order of `middleware`, and which actions a middleware
reading the identity may serve, on `ActionRpc.LayerOptions.middleware`.
[kitchen-sink/src/identity/quota.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/quota.ts) is a limit
in `middleware`, keyed on the caller, and
[kitchen-sink/src/Rpc.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Rpc.ts) binds the protected actions
alone for it.

- **On Cloudflare Workers.** `RpcServer.layerProtocolWebsocket` cannot upgrade a request there:
  serve the rpcs from a Durable Object with `@gjermundgaraba/effect-actions-cloudflare`, whose
  sockets hibernate.
- **The same actions as JSON too.** Merge `ActionHttp.layer(Http, implementations)` beside the
  rpc layer, each given its descriptor's provider
  ([kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts) defines both, and
  [server.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/server.ts) merges them): one provider given to both
  is built once. The routes need what the rpcs did not: an `httpApiStatus` on a declared error,
  by the rule on `Action.Options.error`, and router middleware for a service an `RpcMiddleware`
  provides ([ActionHttp.md](ActionHttp.md#serve-the-routes)).
- **An rpc of your own beside the actions.** Give `ActionRpc.make` native rpcs in `rpcs`,
  `ActionRpc.make(actions, { authentication, rpcs: RpcGroup.make(Upload) })`, each with its own
  schemas: under the binding's `authentication` each message authenticates as a protected
  action's does, and the client has their methods beside the actions'. Implement them with the
  binding's own `Rpc.rpcs.toLayer(handlers)`, whose handlers read the identity and authorize it
  themselves, and provide that to `ActionRpc.layer`, which otherwise does not compile. The rules
  are on `ActionRpc.Options.rpcs`.
- **An action reporting progress or answering a stream is a stream rpc.** Over a WebSocket, or
  HTTP under `RpcSerialization.layerNdjson`, its values and elements arrive as sent; under
  `layerJson` over HTTP, all at the end (`ActionRpc.layer`).

## Call the rpcs

`ActionRpc.client(Rpc)` has the methods of `ActionHttp.client`
([ActionHttp.md](ActionHttp.md#call-the-api-from-effect)), and what one call fails with is
`ActionRpc.MethodError`. A page's client module:

```ts example=live-rpc/src/browser.ts
import { Effect, Layer, Stream } from "effect";
import { Headers } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { MessagePosted, roomHeader } from "./chat/Chat.js";
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
      const headers = { authorization: `Bearer ${token}`, [roomHeader]: name };
      const here = RpcClient.withHeaders(headers);

      return {
        // What the room holds after the last id the page has. A token may expire while the
        // page stays open, so each refusal becomes what the page shows.
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

        // Each message posted to the room after the last id the page holds: a page opening a
        // room reads it, then watches from the last id it read, so a post between the two is
        // not lost; 0 sends the room's history first. `watch` connects again after a drop and
        // resumes from the last message it delivered, so the page never subscribes by hand; a
        // `Gap` says some were missed, or are another run's, so the page reads the room again
        // with `read(0)`. The headers go with the
        // stream, as `here` puts them on a call, and so with every request it sends again. A
        // refusal ends it, as when it connects again with a token that has expired.
        messages: (after: number) =>
          client
            .watch(MessagePosted, {}, { cursor: String(after) })
            .pipe(
              Stream.updateService(
                RpcClient.CurrentHeaders,
                Headers.merge(Headers.fromInput(headers)),
              ),
            ),

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

[live-rpc/src/client.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/client.ts) runs it from Node, and
[live-rpc/src/page.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/page.ts) wraps it in promises for a page that is
not one Effect program. The client's traps are on `ActionRpc.client`.

- **A server that closes a socket to refuse it.** Effect's socket client connects again after
  any close, backing off to every five seconds, for good. Give `RpcClient.layerProtocolSocket` the
  `retryPolicy` `ActionRpc.reconnectUntil(code)`, and a close with that code ends its calls
  instead.

## Serve and watch events

List [event types](Event.md) in the binding beside the actions: each is a stream rpc, which a
client's `watch` holds open on its socket. How, with a room's messages over a WebSocket:
[ActionRpc-events.md](ActionRpc-events.md).

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
  ([kitchen-sink/src/browser.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/browser.ts)). A browser attaches
  it from any page, so refuse a foreign `Origin` on the upgrade, with a request policy
  ([Authentication-advanced.md](Authentication-advanced.md#run-a-request-policy-before-authentication)).
