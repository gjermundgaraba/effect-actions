# ActionDurableObject

Actions served from a Cloudflare Durable Object: one class whose instances build the routes the
core serves elsewhere, Effect RPC on WebSockets the runtime holds while the object hibernates,
an alarm, and a client for a Worker to call an object through its stub. Reach for it when state
belongs to one thing, such as a room, a document or a tenant, and its callers should meet in
one place.

Read this page alone, in one tool call; if its output says it was truncated, read it again alone.
When something fails, search [ActionDurableObject-failures.md](ActionDurableObject-failures.md).
Reading order: [README.md](README.md).

## API

Import `@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject`.

| API                                        | Purpose                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `make({ routes, alarm?, disableLogger? })` | A Durable Object class serving `routes` on `fetch` and its sockets' events.      |
| `State`                                    | The object's `DurableObjectState`, `ctx`: a startup service of routes and alarm. |
| `layerWebSocket(Rpc, { path })`            | The hibernating `RpcServer.Protocol` `ActionRpc.layer` serves `Rpc` on.          |
| `layerHttpClient(stub)`                    | An `HttpClient` sending every request to a stub or a service binding.            |

Exported types: `Options` of `make`, `LayerWebSocketOptions` of `layerWebSocket`, and `Instance`,
an instance of the class `make` returns.

| Option                      | Meaning                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `make`: `routes`            | A Layer of routes, as `HttpRouter.toWebHandler` serves them: `ActionRpc.layer`, `ActionHttp.layer`. |
| `make`: `alarm`             | A function of the runtime's alarm information to the Effect the object's `alarm` runs.              |
| `make`: `disableLogger`     | Leave out the request logger `toWebHandler` adds.                                                   |
| `layerWebSocket`: `path`    | The upgrade route.                                                                                  |
| `layerWebSocket`: `headers` | Headers of the upgrade request a socket keeps and sends again under each message's own.             |

## Serve actions from an object

Give `make` the routes, as the core's surfaces build them, and export the class it returns,
or one extending it, under the name the Wrangler configuration binds. Each instance builds the
routes once, in its constructor, with `State` and the platform's services provided, and holds
every event until they are built.

```ts
export class ChatRoom extends ActionDurableObject.make({
  routes: roomRoutes.pipe(Layer.provide([layerSql, layerRoom])),
}) {}
```

[chat-rooms/src/worker.ts](../examples/chat-rooms/src/worker.ts) is that class, beside the
Worker's own `fetch`; [chat-rooms/wrangler.jsonc](../examples/chat-rooms/wrangler.jsonc) binds
it with a SQLite migration.

- Set a `compatibility_date` of `2026-04-07` or later: from then the runtime replies to a
  client's close frame itself. `layerWebSocket` sends no reply of its own.
- `make` provides `State`, the router and the platform's services: provide every other service
  the routes require to them.
- A service read from the object, such as a SQLite store, is a Layer requiring `State`
  ([chat-rooms/src/platform/sql-store.ts](../examples/chat-rooms/src/platform/sql-store.ts)).
  So is what the object is, such as its name
  ([chat-rooms/src/platform/object-name.ts](../examples/chat-rooms/src/platform/object-name.ts)).
- An authorizer that depends on the object, such as on its room, yields that startup service
  once, when it is built: make `authorize` an Effect returning the function, as the core's
  `Action.md` shows for a store
  ([chat-rooms/src/chat/authorize.ts](../examples/chat-rooms/src/chat/authorize.ts)).
- JSON routes and rpcs merge in one routes Layer: both are served on `fetch`.

## Serve rpcs over hibernating WebSockets

Provide `ActionRpc.layer` the protocol `layerWebSocket` makes for the binding it serves, at a
path of the object's.

```ts
ActionRpc.layer(RoomRpc, room).pipe(
  Layer.provide(ActionDurableObject.layerWebSocket(RoomRpc, { path: "/rpc" })),
);
```

- The object accepts each socket with the runtime's hibernation API, so an idle object is
  evicted while its sockets stay open: a message constructs a new instance, which builds the
  routes and answers it.
- A socket keeps the credential the binding's authentication descriptor reads from its upgrade
  request, its `Authorization` header, an API key's header or its cookie, and the `headers`
  listed, and no other header: Effect's own socket protocol keeps them all, so list any a
  middleware reads, such as `Origin`. Each message is authenticated with those and its own
  headers, its own winning. An API key in the query string is not kept.
- Serve the protocol with `ActionRpc.layer` alone. A message's event lasts until each of its
  requests has its exit, so the object stays awake while a call runs; `RpcServer.layer` answers
  a handler's defect without an exit, which would hold the event until the socket closes.
- Give each protocol of one object its own `path`. A router prefix does not tell two apart:
  routes with two protocols at one path, under `HttpRouter.prefixed` or not, fail to build.
- `layerWebSocket` serves only the routes of a class `make` returns, which receives its
  sockets' events; built elsewhere, it fails to build.
- The verifier runs for every message, so a token that expires refuses the next call. A client
  that renews its token sends the new one on its messages, or connects again.
- A browser WebSocket sets no header on its upgrade: a page sends its token on each message,
  with `RpcClient.withHeaders`
  ([chat-rooms/src/browser.ts](../examples/chat-rooms/src/browser.ts)). A Worker or a native app
  sets it on the upgrade once.
- The socket speaks JSON, Effect's `RpcSerialization.layerJson` on the client, over
  `RpcClient.layerProtocolSocket` and `Socket.layerWebSocket(url)`.
- The runtime answers the client's pings itself, every five seconds, so an open page does not
  wake the object.
- `RpcServer.layerProtocolWebsocket` cannot serve rpcs here: it upgrades through the server's
  request, and a web handler's request cannot be upgraded.

## Run an alarm

Give `make` an `alarm`, and set it from a handler or a store with `State`'s
`storage.setAlarm`. It runs once the routes are built, with `State` and a `Scope`, closed when
it ends.

```ts
alarm: () => MessageStore.use((store) => store.expire).pipe(Effect.provide(layerSql)),
```

- Provide it the same Layer value the routes are given: an instance builds it once for both,
  as [chat-rooms/src/worker.ts](../examples/chat-rooms/src/worker.ts) does with `layerSql`.
- Its argument is the runtime's `AlarmInvocationInfo`, `retryCount` and `isRetry`, or
  `undefined` when the object's `alarm` is called with none.
- A failure rejects the object's `alarm`, which the runtime retries with backoff, up to six
  times. An object made without an `alarm` rejects every alarm the same way.
- The object has one alarm. [chat-rooms/src/platform/sql-store.ts](../examples/chat-rooms/src/platform/sql-store.ts)
  sets it for the oldest message's expiry and, each run, for the next.

## Call an object from a Worker

Provide the core's client `layerHttpClient` with the object's stub: every request goes to the
object's `fetch` in place of the network.

```ts
ActionHttp.client(RoomHttp, { baseUrl: "https://room" }).pipe(
  Effect.flatMap((client) => client.preview()),
  Effect.provide(ActionDurableObject.layerHttpClient(env.CHAT_ROOM.getByName(room))),
);
```

- The URL needs a host, which the stub ignores. `ActionRpc.client` over
  `RpcClient.layerProtocolHttp` and `ActionMcp.client` take the same layer.
- Nothing authenticates the request on its way: a protected action needs the caller's
  credential, forwarded with `transformClient`, as for any remote surface.
- To pass a page's requests to an object, forward the `Request` itself: its upgrade goes with
  it, and the object answers it
  ([chat-rooms/src/worker.ts](../examples/chat-rooms/src/worker.ts)).
- Only names you accept should reach `getByName`: each name is another object.

## Test on the Workers runtime

Run the tests inside the runtime with `@cloudflare/vitest-plugin`, on the Worker the Wrangler
configuration describes: `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })` in
the test configuration
([chat-rooms/vite.config.ts](../examples/chat-rooms/vite.config.ts)). From `cloudflare:test`:

- `evictDurableObject(stub)` evicts an instance as hibernation does: the next call builds the
  routes again, and its sockets stay open.
- `runDurableObjectAlarm(stub)` runs a set alarm now; `runInDurableObject(stub, fn)` reads or
  changes the object's storage directly.

Call through the Worker as a deployment would, with `layerHttpClient(exports.default)`, and
open a socket by upgrading through its `fetch`, handing `response.webSocket` to
`Socket.fromWebSocket` under `RpcClient.layerProtocolSocket`
([chat-rooms/test/support/socket.ts](../examples/chat-rooms/test/support/socket.ts),
[chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts)). The core's
`Testing.layer` serves the same routes in memory, but cannot upgrade a socket.

## Limits

- **An instance lasts until it is evicted.** Nothing the routes build is finalized, in-memory
  state is lost, and the next instance builds everything again. Keep state in storage.
- **The build holds the object.** It runs in `blockConcurrencyWhile`, which the runtime limits
  to 30 seconds. A build that fails or exceeds it resets the object: the event's caller gets
  the error, and the next event builds again.
- **Router middleware does not reach a socket's messages.** Router middleware and
  `HttpRouter.provideRequest` around the routes run for the upgrade request alone, so a
  service only they provide is missing from every call over the socket. Provide a per-message
  service with a middleware listed in `ActionRpc.layer`'s `middleware`, and a value of the
  object's as a startup service.
- **A socket keeps at most 16 KiB.** The credential and the listed headers it keeps are
  refused past the runtime's attachment limit: the upgrade is answered `431`.
- **A call keeps the object awake.** The object is billed while a call runs, so a call that
  waits for something to happen keeps it awake as long: a client reads again instead.
- **JSON only**, on the socket.
- **Bodies are limited by the platform**: `toWebHandler` reads no `MaxBodySize`.
