# ActionDurableObject

Actions served from a Cloudflare Durable Object: the routes the core serves elsewhere, Effect
RPC on WebSockets the runtime holds while the object hibernates and over the object's stub,
with Cloudflare's own RPC, an alarm, and clients for a Worker to call an object through its
stub. Reach for it when state belongs to one thing, such
as a room, a document or a tenant, and its callers should meet in one place. Its primitives
work in any Durable Object class; `make` is a class built from them.

Read this page alone, in one tool call; if its output says it was truncated, read it again alone.
For calls over the stub, read [ActionDurableObject-stub.md](ActionDurableObject-stub.md); for a
class of your own, [ActionDurableObject-own-class.md](ActionDurableObject-own-class.md).
When something fails, search [ActionDurableObject-failures.md](ActionDurableObject-failures.md).
Reading order: [README.md](README.md).

## API

Import `@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject`.

| API                                                  | Purpose                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `State`                                              | The object's `DurableObjectState`, `ctx`: a startup service of services, routes and alarm.   |
| `Sockets`, `Sockets.layer`                           | The object's dispatcher for the sockets its routes' protocols accept, one per instance.      |
| `layerWebSocket({ path })`                           | The hibernating `RpcServer.Protocol` `ActionRpc.layer` serves on, registered with `Sockets`. |
| `Calls`, `Calls.layer`                               | The object's dispatcher for the calls over its stub, one per instance.                       |
| `layerStub()`                                        | The `RpcServer.Protocol` over the object's stub, registered with `Calls`.                    |
| `layerStubClient(stub)`                              | The `RpcClient.Protocol` calling an object's rpcs over its stub.                             |
| `client(group, stubOf)`                              | `(key) => client` of a group's rpcs on the objects `stubOf` reaches, declared errors typed.  |
| `layerHttpClient(stub)`                              | An `HttpClient` sending every request to a stub or a service binding.                        |
| `handlers(ctx, { services?, routes?, calls?, ... })` | The object's handlers, for a class of your own to delegate to.                               |
| `make({ services?, routes?, calls?, alarm?, ... })`  | A Durable Object class delegating every handler to `handlers`.                               |

Exported types: `Options` of `handlers` and `make`, `Handlers`, what `handlers` returns,
`Instance`, an instance of the class `make` returns, `LayerWebSocketOptions`, `Stub`, what
`layerStubClient` and `client` call, and `Client<typeof group>`, `client`'s per key.
`Sockets`' `message(socket, data)`, `close(socket)` and `error(socket)` succeed with `true`
when a protocol took the event, `false` when none accepted the socket. `Handlers`' and
`Instance`'s `effectActionsRpc` is the method a stub calls, and `run(effect)` runs an
Effect in the object with its services.

| Option                   | Meaning                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `services`               | The object's startup services, a Layer requiring `State` alone, built once per instance.            |
| `routes`                 | A Layer of routes, as `HttpRouter.toWebHandler` serves them: `ActionRpc.layer`, `ActionHttp.layer`. |
| `calls`                  | An rpc server served over the stub, given `layerStub()`: `RpcServer.layer`, `ActionRpc.layer`.      |
| `alarm`                  | A function of the runtime's alarm information to the Effect the object's `alarm` runs.              |
| `disableLogger`          | Leave out the request logger `toWebHandler` adds.                                                   |
| `layerWebSocket`: `path` | The upgrade route.                                                                                  |

## Serve actions from an object

Give `make` the routes, as the core's surfaces build them, and their startup services as
`services`, and export the class it returns, or one extending it, under the name the Wrangler
configuration binds.

```ts
export class ChatRoom extends ActionDurableObject.make({
  services: Layer.mergeAll(layerSql, layerRoom),
  routes: roomRoutes,
}) {}
```

[chat-rooms/src/worker.ts](../examples/chat-rooms/src/worker.ts) is that class, beside the
Worker's own `fetch`; [chat-rooms/wrangler.jsonc](../examples/chat-rooms/wrangler.jsonc) binds
it with a SQLite migration.

- Each instance builds once, on its first event: the services, with `State` provided, then the
  calls, with `Calls`, and the routes, with `Sockets` and the platform's services. Events
  arriving meanwhile await that build. The calls, routes, alarm and every `run` share it.
- Run with the compatibility flag `web_socket_auto_reply_to_close`, on by default from the
  `compatibility_date` `2026-04-07`: with it the runtime replies to a client's close frame
  itself. `layerWebSocket` sends no reply of its own.
- A service the alarm or a `run` needs too belongs in `services`; one only the routes need may
  be provided to them instead.
- An implementation the services build, with `Action.layer` or an in-process `Action.client`
  acquired in a Layer, is the one the routes serve: they build in one memo map.
- A service read from the object, such as a SQLite store, is a Layer requiring `State`
  ([chat-rooms/src/platform/sql-store.ts](../examples/chat-rooms/src/platform/sql-store.ts)).
  So is what the object is, such as its name
  ([chat-rooms/src/platform/object-name.ts](../examples/chat-rooms/src/platform/object-name.ts)).
- An authorizer that depends on the object, such as on its room, yields that startup service
  once, when it is built: make `authorize` an Effect returning the function, as the core's
  `Action.md` shows for a store
  ([chat-rooms/src/chat/authorize.ts](../examples/chat-rooms/src/chat/authorize.ts)).
- JSON routes and rpcs merge in one routes Layer, served on `fetch`, which answers 404 without.
- The services, calls and routes are module-level values, built once per instance: they reach
  bindings through the `env` import of `cloudflare:workers`, read as they build or serve, never
  as the module evaluates ([chat-rooms/src/platform/room-stubs.ts](../examples/chat-rooms/src/platform/room-stubs.ts)).

## Serve rpcs over hibernating WebSockets

Provide `ActionRpc.layer` the protocol `layerWebSocket` makes, at a path of the object's.

```ts
ActionRpc.layer(RoomRpc, room).pipe(
  Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
);
```

- The object accepts each socket with the runtime's hibernation API, so an idle object is
  evicted while its sockets stay open: a message constructs a new instance, which builds the
  routes and then answers it.
- A socket keeps its upgrade request's headers, as Effect's own socket protocol does, its
  credential included, and each message is authenticated with those under its own headers, its
  own winning. An API key in the query string is not kept: a message has no URL. A socket
  whose runtime dropped them has only each message's own (see Limits).
- Under a cookie scheme, refuse a foreign `Origin` with router middleware around the routes: a
  browser sends the cookie on any page's upgrade, an upgrade is never preflighted, and router
  middleware runs for the upgrade, as the core's `Authentication-advanced.md` describes.
- Give each protocol of one object its own `path`. A router prefix does not tell two apart:
  routes with two protocols at one path, under `HttpRouter.prefixed` or not, fail to build.
- `layerWebSocket` registers with the instance's `Sockets`, which hands it its sockets' events:
  routes using it require `Sockets`, which `handlers` and `make` provide.
- A socket the object accepts itself, with `State`'s `acceptWebSocket`, carries no protocol's
  tag: `Sockets` answers `false` for it, and `handlers` resolves its events, so override
  `webSocketMessage`, answer the sockets with your tag, read with `ctx.getTags(socket)`, and
  call `super`, or the handler you delegate to, for the rest.
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

## Run an alarm

Give `make` an `alarm`, and set it from a handler or a store with `State`'s
`storage.setAlarm`. It runs through `run`, once the services and routes are built, with the
services, `State` and a `Scope`, closed when it ends. A class of your own delegates its `alarm`
to `handlers`' ([ActionDurableObject-own-class.md](ActionDurableObject-own-class.md)).

```ts
alarm: () => MessageStore.use((store) => store.expire),
```

- It reads the store the routes read, built once per instance
  ([chat-rooms/src/worker.ts](../examples/chat-rooms/src/worker.ts)).
- Its argument is the runtime's `AlarmInvocationInfo`, `retryCount` and `isRetry`, or
  `undefined` when the object's `alarm` is called with none.
- A class extending the one `make` returns may override `alarm`, and reaches `make`'s with
  `await super.alarm?.(info)`: `Instance` declares Cloudflare's optional `alarm`, as a class made
  without one has none.
- A failure rejects the object's `alarm`, which the runtime retries with backoff, up to six
  times. An object made without an `alarm` has no handler: workerd refuses `storage.setAlarm`
  on it, at that call (see Limits).
- The object has one alarm. [chat-rooms/src/platform/sql-store.ts](../examples/chat-rooms/src/platform/sql-store.ts)
  sets it for the oldest message's expiry and, each run, for the next.

## Call an object from a Worker

Two paths. For the object's own API, which its Worker and other objects call, serve a group
over the stub as `calls` and call it with `client`, by name: the declared errors arrive typed
([ActionDurableObject-stub.md](ActionDurableObject-stub.md)).

```ts
export class PluginHost extends ActionDurableObject.make({
  services: PluginStore.layer,
  calls: RpcServer.layer(PluginRpcs).pipe(Layer.provide(pluginHandlers)),
}) {}

const plugin =
  yield * ActionDurableObject.client(PluginRpcs, (id: string) => env.PLUGIN.getByName(id));
const { pane } = yield * plugin(id).start(); // fails with PluginNotFound | PluginHasNoPane
```

- An `ActionRpc` binding is served the same way, `calls: ActionRpc.layer(RoomRpc, room)`, and
  called with `ActionRpc.client` over `layerStubClient(stub)`: chat-rooms' lobby asks each
  room for its preview so
  ([chat-rooms/src/platform/room-stubs.ts](../examples/chat-rooms/src/platform/room-stubs.ts)).
- Nothing authenticates a stub call: only a binding reaches it.

For the object's routes, `ActionHttp.client`, `ActionMcp.client`, or `ActionRpc.client` over
`RpcClient.layerProtocolHttp`, give the client `layerHttpClient(stub)`: every request goes to
the object's `fetch` in place of the network.

```ts
ActionHttp.client(RoomHttp, { baseUrl: "https://room" }).pipe(
  Effect.flatMap((client) => client.preview()),
  Effect.provide(ActionDurableObject.layerHttpClient(env.CHAT_ROOM.getByName(room))),
);
```

- The URL needs a host, which the stub ignores. Nothing authenticates the request on its way:
  forward the caller's credential with `transformClient`, as for any remote surface.
- To pass a page's requests to an object, forward the `Request` itself: its upgrade goes with
  it ([chat-rooms/src/worker.ts](../examples/chat-rooms/src/worker.ts)).
- A method of the class's own runs its Effect with `run`, which builds a Layer it provides for
  that call alone. Only names you accept should reach `getByName`: each is another object.

## Test on the Workers runtime

Run the tests inside the runtime with `@cloudflare/vitest-plugin`, on the Worker the Wrangler
configuration describes: `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })` in
the test configuration
([chat-rooms/vite.config.ts](../examples/chat-rooms/vite.config.ts)). From `cloudflare:test`:

- `evictDurableObject(stub)` evicts an instance as hibernation does: the next event builds the
  services and routes again, and its sockets stay open.
- `runDurableObjectAlarm(stub)` runs a set alarm now; `runInDurableObject(stub, fn)` reads or
  changes the object's storage directly.

Call an object's `calls` with `layerStubClient(env.<BINDING>.getByName(name))`, the Worker as a
deployment would with `layerHttpClient(exports.default)`, and open a socket by upgrading
through its `fetch`, handing `response.webSocket` to
`Socket.fromWebSocket` under `RpcClient.layerProtocolSocket`
([chat-rooms/test/support/socket.ts](../examples/chat-rooms/test/support/socket.ts),
[chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts)). The core's
`Testing.layer` serves the same routes in memory, but cannot upgrade a socket.

## Limits

- **An instance lasts until it is evicted.** Nothing the services or routes build is finalized,
  in-memory state is lost, and the next instance builds everything again. Keep state in storage.
- **Router middleware does not reach a socket's messages.** Router middleware and
  `HttpRouter.provideRequest` around the routes run for the upgrade request alone, so a
  service only they provide is missing from every call over the socket. Provide a per-message
  service with a middleware listed in `ActionRpc.layer`'s `middleware`, and a value of the
  object's as a startup service.
- **Some guarantees are workerd's, not every runtime's.** On workerd a socket's attachment, the
  headers it keeps, survives hibernation, and `storage.setAlarm` throws on an object with no
  `alarm` handler. celld 0.6.2, Deno's self-hosted runtime, drops the attachment when it evicts
  an idle object, so a message relying on the upgrade's token is refused as unauthenticated,
  and accepts `setAlarm` without a handler, consuming the alarm. Send a token on each message.
- **A socket keeps at most 16 KiB.** Upgrade headers past the runtime's 16,384-byte attachment
  limit are refused: the upgrade is answered `431`. A browser's cookies are usually a few KiB.
- **A socket's call waiting on memory alone can be lost.** A message's event ends once the
  message is handed to the server. A call doing I/O or waiting on a timer keeps the object from
  hibernating, billed as long; one waiting only on in-memory state, such as a `Deferred`, is
  lost if the object hibernates, and its client never hears back. A client reads again.
- **JSON only**, on the socket and the stub.
- **Unary only over the stub.** A call answers once: an rpc that streams is answered with a
  defect. Stream over the socket.
- **32 MiB a stub call**, Workers RPC's limit on a call's serialized request and answer: past
  it, the runtime's `limited to 32MiB` error.
- **Bodies are limited by the platform**: `toWebHandler` reads no `MaxBodySize`.
