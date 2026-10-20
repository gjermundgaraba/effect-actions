# ActionDurableObject

Actions served from a Cloudflare Durable Object. A **Durable Object** is a class a Worker's
Wrangler configuration binds, with one **object** per id or name, running in one place at a
time with its own storage. The runtime constructs an **instance** of the class for an object's
first event, **evicts** it when idle, and constructs another for the next. An object serves the
routes the core serves elsewhere, Effect RPC on WebSockets the runtime holds open while the
object **hibernates**, evicted with its sockets kept, rpcs over its stub, and an alarm. Reach
for it when state belongs to one thing, such as a room, a document or a tenant, and its
callers should meet in one place.

Import `@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject`. A message the library
throws says its fix; for workerd's, a compiler diagnostic or Effect's own error,
search [ActionDurableObject-failures.md](ActionDurableObject-failures.md). For one symbol,
`grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions-cloudflare/dist/`: each
declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot
show. Calls over the stub are on [ActionDurableObject-stub.md](ActionDurableObject-stub.md),
pushing to pages over their sockets on
[ActionDurableObject-feed.md](ActionDurableObject-feed.md), and a class that cannot extend
`make`'s on [ActionDurableObject-own-class.md](ActionDurableObject-own-class.md).

## Serve actions from an object

Give `make` the routes, as the core's surfaces build them, and their startup services, and
export the class it returns, or one extending it, under the name the Wrangler configuration
binds. The entrypoint holds the room's class beside the Worker's own `fetch`:

```ts example=chat-rooms/src/worker.ts
import { Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { RoomName } from "./chat/Chat.js";
import { MessageStore } from "./chat/store.js";
import { layerRoom } from "./platform/object-name.js";
import { layerRooms } from "./platform/room-stubs.js";
import { layerSql } from "./platform/sql-store.js";
import { lobbyRoutes, roomCalls, roomRoutes } from "./routes.js";

// Entrypoint, Wrangler's `main`: the composition root of the Worker and of every room's
// object. It chooses the store and the room, and routes each request.

// A room's Durable Object, bound as CHAT_ROOM in wrangler.jsonc under this export's name. Each
// instance builds its services, the store and the room, then its calls and routes, on its
// first event, again after every eviction. The alarm expires old messages; `post` sets it. It
// reads the store the instance built for the calls and routes.
export class ChatRoom extends ActionDurableObject.make({
  services: () => Layer.mergeAll(layerSql, layerRoom),
  routes: roomRoutes,
  calls: roomCalls,
  alarm: () => MessageStore.use((store) => store.expire),
}) {}

// The lobby's handler, built once, when the module loads: building it does no I/O, which a
// Worker refuses outside a request. `toWebHandler` reads no `MaxBodySize`, so the platform
// limits request bodies.
const lobby = HttpRouter.toWebHandler(
  lobbyRoutes.pipe(Layer.provide(layerRooms), Layer.provide(HttpServer.layerServices)),
);

const isRoomName = Schema.is(RoomName);

// `/rooms/<room>/<path>` is the room's object's `<path>`, its socket's upgrade included:
// forwarding the request forwards its upgrade, and the object answers it. Everything else is
// the lobby's.
export default {
  fetch(request: Request, env: Cloudflare.Env) {
    const url = new URL(request.url);
    const [, room = "", rest = "/"] = /^\/rooms\/([^/]+)(\/.*)?$/u.exec(url.pathname) ?? [];

    if (!isRoomName(room)) return lobby.handler(request);

    url.pathname = rest;

    return env.CHAT_ROOM.getByName(room).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
```

[chat-rooms/wrangler.jsonc](../examples/chat-rooms/wrangler.jsonc) binds the class with a
SQLite migration. The rules of each option, when it builds and what it may require, are on
`ActionDurableObject.Options`; what an instance builds, and when again, on
`ActionDurableObject.handlers`; the class itself on `ActionDurableObject.make`, whose
`services` is a function of the instance's `env`, `() => layer` for services reading none.

- A service read from the object is a Layer requiring `State`: a store over its SQLite
  database ([chat-rooms/src/platform/sql-store.ts](../examples/chat-rooms/src/platform/sql-store.ts)),
  or what the object is, such as its name
  ([chat-rooms/src/platform/object-name.ts](../examples/chat-rooms/src/platform/object-name.ts)).
- An authorizer that depends on the object, such as on its room, yields that startup service
  once, when it is built
  ([chat-rooms/src/chat/authorize.ts](../examples/chat-rooms/src/chat/authorize.ts)).
- A class extending the one `make` returns overrides only the handlers it has reason to
  write, and reaches `make`'s with `super`; a socket it accepts itself is its own to answer.

## Serve rpcs over hibernating WebSockets

Give `ActionRpc.layer` the protocol `layerWebSocket` makes, at a path of the object's, beside
the JSON routes in one routes Layer:

```ts example=chat-rooms/src/routes.ts
import { Layer } from "effect";
import { RpcServer } from "effect/rpc";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { LobbyHttp, RoomHttp } from "./Api.js";
import { RoomCalls } from "./chat/Calls.js";
import { calls, messages, preview, watch } from "./chat/handlers.js";
import { authenticate } from "./identity/verifier.js";
import { lobby } from "./lobby/handlers.js";
import { RoomRpc } from "./Rpc.js";

const room = [preview, messages];

// What a room's object serves. Its rpcs on WebSockets the runtime holds while the object
// hibernates: a socket keeps the token its upgrade request carried, and each message is
// authenticated with it, or with the message's own. `watch`'s handler is the host's, as an
// Effect rpc's is. Its JSON routes at `/api/<action>`. It requires `MessageStore` and `Room` at
// startup: worker.ts chooses them.
export const roomRoutes = Layer.mergeAll(
  ActionRpc.layer(RoomRpc, room).pipe(
    Layer.provide(watch),
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
  ),
  ActionHttp.layer(RoomHttp, room),
).pipe(Layer.provide(authenticate));

// What a room's object serves over its stub: its own calls, on Effect's own RpcServer, for the
// Worker, which calls them with Cloudflare's own RPC. It requires `MessageStore` at startup.
export const roomCalls = RpcServer.layer(RoomCalls).pipe(Layer.provide(calls));

// What the Worker serves itself: the lobby, which asks the rooms' objects. It requires `Rooms`.
export const lobbyRoutes = ActionHttp.layer(LobbyHttp, lobby);
```

What a socket keeps across hibernation, how each message authenticates, and what the runtime
answers itself are on `ActionDurableObject.layerWebSocket`. A page's client speaks JSON over
`RpcClient.layerProtocolSocket` and `Socket.layerWebSocket(url)`, its token on each message
([chat-rooms/src/browser.ts](../examples/chat-rooms/src/browser.ts)), and the Worker forwards a
page's upgrade to the room's object by forwarding its `Request`, as `worker.ts` does above. The
`watch` the routes provide is the binding's rpc that streams, which pushes each message to the
pages following the room: [ActionDurableObject-feed.md](ActionDurableObject-feed.md).

## Run an alarm

Give `make` an `alarm`, and set it from a handler or a store with `State`'s
`storage.setAlarm`: the room's store sets it for the oldest message's expiry and, each run,
for the next
([chat-rooms/src/platform/sql-store.ts](../examples/chat-rooms/src/platform/sql-store.ts)), and
`worker.ts` above gives the alarm the store the routes read. How it runs, and how a failure is
retried, are on `ActionDurableObject.Options`' `alarm`.

## Call an object from a Worker

Call its `calls` with `client`, the declared errors typed, and its routes with the core's
clients over `layerHttpClient(stub)`: [ActionDurableObject-stub.md](ActionDurableObject-stub.md).

## Test on the Workers runtime

Run the tests inside the runtime with `@cloudflare/vitest-plugin`, on the Worker the Wrangler
configuration describes:

```ts example=chat-rooms/vite.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

// Its tests run inside the Workers runtime, on the Worker wrangler.jsonc describes.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/**/*.test.ts"] },
});
```

From `cloudflare:test`, `evictDurableObject(stub)` evicts an instance as hibernation does,
its sockets staying open, `runDurableObjectAlarm(stub)` runs a set alarm now, and
`runInDurableObject(stub, fn)` reads or changes the object's storage directly. Call the Worker
as a deployment would with `layerHttpClient(exports.default)`, and open a socket by upgrading
through its `fetch`, handing `response.webSocket` to `Socket.fromWebSocket` under
`RpcClient.layerProtocolSocket`
([chat-rooms/test/support/socket.ts](../examples/chat-rooms/test/support/socket.ts),
[chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts)). The core's
`Testing.layer` serves the same routes in memory, but cannot upgrade a socket. Under
**celld**, Deno's self-hosted Durable Object runtime, `CELLD_IDLE_EVICT_S` is the equivalent of
`evictDurableObject`: the idle seconds after which it evicts an object.

## Deploy

workerd, Cloudflare's runtime, serves an object's sockets under any `compatibility_date`.
celld 0.6.2 differs from it twice, each difference a gotcha of the declaration it touches: a
socket's upgrade headers after an eviction, on `ActionDurableObject.layerWebSocket`, and an
alarm set on a class made without `alarm`, on `ActionDurableObject.make`. What an eviction
loses is on `ActionDurableObject.handlers`.
