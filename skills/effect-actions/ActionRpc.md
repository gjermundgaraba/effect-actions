# ActionRpc

Actions as Effect RPC, on Effect's own `RpcServer` and `RpcClient`: one rpc per action, a stream rpc per event type, and native rpcs of your own beside them.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [ActionRpc-failures.md](ActionRpc-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot show.

## Bind actions to rpcs

A binding that holds a protected action names its authentication descriptor ([Authentication.md](Authentication.md#declare-how-callers-sign-in)); the rules of each option are on `ActionRpc.Options`. Call `ActionRpc.make` once and export the binding:

```ts example=live-rpc/src/Rpc.ts
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

import { ListRooms, MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

export const Rpc = ActionRpc.make([ListRooms, ...Messages, MessagePosted], {
  authentication: Login,
});
```

[kitchen-sink/src/Rpc.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Rpc.ts) adds `error`, what its middleware fails with.

## Serve the rpcs

In the routes file, give `ActionRpc.layer` the binding and the implementations, and provide what it requires except the protocol and the startup services the entrypoint chooses: the service of each listed middleware and, where it serves a protected action, the authentication provider ([Authentication.md](Authentication.md#verify-credentials)).

```ts example=live-rpc/src/routes.ts
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Layer } from "effect";

import { messageEvents } from "./chat/events.js";
import { messages, rooms } from "./chat/handlers.js";
import { ResolveRoom, resolveRoom } from "./chat/room.js";
import { authenticate } from "./identity/verifier.js";
import { Rpc } from "./Rpc.js";

export const rpc = ActionRpc.layer(Rpc, [rooms, messages, messageEvents], {
  middleware: [ResolveRoom],
}).pipe(Layer.provide([resolveRoom, authenticate]));
```

The entrypoint serves the result with `HttpRouter.serve`; a test serves it in memory ([Testing.md](Testing.md#test-rpcs)).

```ts example=live-rpc/src/server.ts
import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { MessageStore } from "./chat/store.js";
import { rpc } from "./routes.js";

const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson)
);

const server = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Config.String("HOST").pipe(
      Config.withDefault("127.0.0.1")
    );

    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    return HttpRouter.serve(socket).pipe(
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host,
          port,
          websocket: { maxPayload: 64 * 1024 },
        })
      ),
      Layer.provide(MessageStore.layerMemory),
      Layer.provide(Event.layerMemory)
    );
  })
);

Layer.launch(server).pipe(NodeRuntime.runMain());
```

Where the protocol goes, why one protocol takes one layer, and what a protocol with no router lacks are on `ActionRpc.layer`; the order of `middleware`, and which actions a middleware reading the identity may serve, on `ActionRpc.LayerOptions.middleware`. [kitchen-sink/src/identity/quota.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/quota.ts) is a limit in `middleware`, keyed on the caller, and [kitchen-sink/src/Rpc.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Rpc.ts) binds the protected actions alone for it.

- **On Cloudflare Workers**, serve the rpcs from a Durable Object, with `@gjermundgaraba/effect-actions-cloudflare`'s `ActionDurableObject.layerWebSocket`.
- **The same actions as JSON too.** Merge `ActionHttp.layer(Http, implementations)` beside the rpc layer, each given its descriptor's provider ([kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts) defines both, and [server.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/server.ts) merges them): one provider given to both is built once. The routes need what the rpcs did not: an `httpApiStatus` on a declared error, by the rule on `Action.Options.error`, and router middleware for a service an `RpcMiddleware` provides ([ActionHttp.md](ActionHttp.md#serve-the-routes)).
- **An rpc of your own beside the actions.** Give `ActionRpc.make` native rpcs in `rpcs`, `ActionRpc.make(actions, { authentication, rpcs: RpcGroup.make(Upload) })`, each with its own schemas: under the binding's `authentication` each message authenticates as a protected action's does, and the client has their methods beside the actions'. Implement them with the binding's own `Rpc.rpcs.toLayer(handlers)`, whose handlers read the identity and authorize it themselves, and provide that to `ActionRpc.layer`, which otherwise does not compile. The rules are on `ActionRpc.Options.rpcs`.
- **An action reporting progress or answering a stream is a stream rpc.** Over a WebSocket, or HTTP under `RpcSerialization.layerNdjson`, its values and elements arrive as sent; under `layerJson` over HTTP, all at the end (`ActionRpc.layer`).

## Call the rpcs

`ActionRpc.client(Rpc)` has the methods of `ActionHttp.client` ([ActionHttp.md](ActionHttp.md#call-the-api-from-effect)), and what one call fails with is `ActionRpc.MethodError`. A page's client module:

```ts example=live-rpc/src/browser.ts
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Layer, Stream } from "effect";
import { Headers } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { MessagePosted, roomHeader } from "./chat/Chat.js";
import { Rpc } from "./Rpc.js";

export const connection = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(RpcSerialization.layerJson)
  );

export const openChat = Effect.gen(function* () {
  const client = yield* ActionRpc.client(Rpc);

  return {
    rooms: Effect.map(client.listRooms(), ({ rooms }) => rooms),

    room: (name: string, token: string) => {
      const headers = { authorization: `Bearer ${token}`, [roomHeader]: name };
      const here = RpcClient.withHeaders(headers);

      return {
        read: (after: number) =>
          client.readMessages({ after }).pipe(
            here,
            Effect.map(({ messages }) => ({
              access: "member" as const,
              messages,
            })),
            Effect.catchTags({
              Unauthenticated: () =>
                Effect.succeed({ access: "signed-out" as const, messages: [] }),
              Forbidden: () =>
                Effect.succeed({
                  access: "not-a-member" as const,
                  messages: [],
                }),
            })
          ),

        post: (text: string) => client.postMessage({ text }).pipe(here),

        messages: (after: number) =>
          client
            .watch(MessagePosted, {}, { cursor: String(after) })
            .pipe(
              Stream.updateService(
                RpcClient.CurrentHeaders,
                Headers.merge(Headers.fromInput(headers))
              )
            ),

        remove: (id: number) =>
          client.deleteMessage({ id }).pipe(
            here,
            Effect.as("removed" as const),
            Effect.catchTags({
              MessageNotFound: () => Effect.succeed("removed" as const),
              NotAuthor: () => Effect.succeed("not-yours" as const),
            })
          ),
      };
    },
  };
});
```

[live-rpc/src/client.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/client.ts) runs it from Node, and [live-rpc/src/page.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/page.ts) wraps it in promises for a page that is not one Effect program. The client's traps are on `ActionRpc.client`.

- **A server that closes a socket to refuse it.** Effect's socket client connects again after any close, backing off to every five seconds, for good. Give `RpcClient.layerProtocolSocket` the `retryPolicy` `ActionRpc.reconnectUntil(code)`, and a close with that code ends its calls instead.

## Serve and watch events

List [event types](Event.md) in the binding beside the actions: each is a stream rpc, which a client's `watch` holds open on its socket. How, with a room's messages over a WebSocket: [ActionRpc-events.md](ActionRpc-events.md).

## Send request context with a call

What travels beside a call's input, such as a token, a tenant or a room, goes in headers: the client wraps the call in `RpcClient.withHeaders`, as `room` does in `browser.ts` above. On the server, authentication decodes the credential from those headers. Anything else is read by native `RpcMiddleware` listed in `ActionRpc.layer`'s `middleware`:

```ts example=live-rpc/src/chat/room.ts
import { Context, Effect, Layer } from "effect";
import { RpcMiddleware } from "effect/rpc";

import { defaultRoom, roomHeader } from "./Chat.js";

/**
 * The room a message is about. A request-time service: handlers and `authorize` read it per
 * call, and it has no Layer, because no one value of it is right for a whole server.
 */
export class CurrentRoom extends Context.Service<CurrentRoom, string>()(
  "live-rpc/CurrentRoom"
) {}

export class ResolveRoom extends RpcMiddleware.Service<
  ResolveRoom,
  { provides: CurrentRoom }
>()("live-rpc/ResolveRoom") {}

export const resolveRoom = Layer.succeed(ResolveRoom, (call, { headers }) =>
  Effect.provideService(call, CurrentRoom, headers[roomHeader] ?? defaultRoom)
);
```

Why router middleware is no substitute over a WebSocket is on `ActionRpc.LayerOptions.middleware`.

- **A cookie the browser attaches to the upgrade covers every message** ([kitchen-sink/src/browser.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/browser.ts)). A browser attaches it from any page, so refuse a foreign `Origin` on the upgrade, with a request policy ([Authentication-advanced.md](Authentication-advanced.md#run-a-request-policy-before-authentication)).
