# ActionDurableObject over the stub

Call an object's rpcs from its Worker, or from another object, with Cloudflare's own RPC: the
operations are declared once, as an Effect `RpcGroup` or an `ActionRpc` binding, served by the
object on one method, and called with a typed client whose errors are the declared ones. Read
[ActionDurableObject.md](ActionDurableObject.md) first: its API and limits hold here too. When
something fails, search [ActionDurableObject-failures.md](ActionDurableObject-failures.md).

## Serve a group over the stub

Give `make` the rpc server as `calls`: `make` provides it the protocol, `layerStub()`, and
defines the method a caller's client calls, `effectActionsRpc`, named for the package so it
does not collide with the class's own.

```ts
export const PluginRpcs = RpcGroup.make(
  Rpc.make("start", {
    success: Schema.Struct({ pane: Schema.String }),
    error: Schema.Union([PluginNotFound, PluginHasNoPane]),
  }),
);

export class PluginHost extends ActionDurableObject.make({
  services: PluginStore.layer,
  calls: RpcServer.layer(PluginRpcs).pipe(Layer.provide(pluginHandlers)),
}) {}
```

- A plain group, `Rpc.make` with `payload`, `success` and `error` schemas, suits an object's
  internal API, which only its Worker and other objects call. An `ActionRpc` binding suits an
  API that is a surface, with its contract, authentication and clients elsewhere:
  `calls: ActionRpc.layer(RoomRpc, room).pipe(Layer.provide(authenticate))`
  ([chat-rooms/src/routes.ts](../examples/chat-rooms/src/routes.ts)).
- The calls build once per instance, after the services and beside the routes, in one memo map:
  an implementation the services build is the one they serve. They may require the protocol,
  which `make` gives them, never one of their own, `State` and the services. A requirement of each call must be provided by the group's
  middleware or be one of those: nothing else reaches a call.
- An object serving only calls builds no router and no request logger: without `routes`, its
  `fetch` answers 404.
- Each call is one call of the method, carrying one request and answered once its exit is
  known. `RpcServer.layer`'s and `ActionRpc.layer`'s middleware run as on any protocol.
- One stub protocol serves an object: serve several groups as one, `group.merge(other)`.
- Unary only: an rpc declared with `stream: true` is answered with a defect at its first chunk,
  and `client` refuses a group holding one as it is made. Stream over `layerWebSocket`.
- A class of your own gives `handlers` the same `calls` and delegates the method
  ([ActionDurableObject-own-class.md](ActionDurableObject-own-class.md)). Its other methods stay
  callable over the stub beside it.

## Call objects by name

`client(group, stubOf)` makes one client, in the caller's `Scope`, for every object `stubOf`
reaches, and returns `(key) => client`. A call goes to its key's stub and fails with the rpc's
declared errors; a failure of the stub itself is a defect.

Before, from an application calling three objects: a hand-typed stub interface, a method per
operation on the object, a wrapper per call, and the declared errors rebuilt in the Worker.

```ts
export interface PluginHostRpc {
  start(): Promise<{ pane: string } | { refused: "not installed" | "no Pane" }>;
}

const started = yield * Effect.promise(() => hosts.plugin(plugin).start());

if ("pane" in started) return started;

return yield * started.refused === "no Pane"
  ? new PluginHasNoPane({ plugin })
  : new PluginNotFound({ plugin });
```

After: the group is the interface, and the handler's call is one line.

```ts
export class Hosts extends Context.Service<
  Hosts,
  { readonly plugin: (id: string) => ActionDurableObject.Client<typeof PluginRpcs> }
>()("app/Hosts") {
  static readonly layer = Layer.effect(Hosts)(
    Effect.map(
      ActionDurableObject.client(PluginRpcs, (id: string) => env.PLUGIN.getByName(id)),
      (plugin) => Hosts.of({ plugin }),
    ),
  );
}

startPane: ({ plugin }) => hosts.plugin(plugin).start(),
```

- `hosts.plugin(id).start()` is an `Effect<{ pane }, PluginNotFound | PluginHasNoPane>`.
- The one client holds nothing per object: its calls are correct across evictions, and a
  Worker reaching many names keeps nothing for each.
- `stubOf` returns the stub, `getByName`'s or `get(idFromString(id))`'s. Only keys you accept
  should reach `getByName`: each name is another object.
- A stub's failure, such as an object without `calls` or an answer past the platform's limit,
  is one its caller cannot recover from, so `client` makes it a defect. For Effect's own typing,
  with `RpcClientError` in every call's errors, call `RpcClient.make(group)` over
  `layerStubClient(stub)`.
- From another object, make the client in a startup service, reading the binding from the
  `env` import of `cloudflare:workers` as the service builds.
- Read `env` as the client is made or called, never as the module evaluates.

An `ActionRpc` binding is called with its own client over the stub:

```ts
ActionRpc.client(RoomRpc).pipe(
  Effect.flatMap((client) => client.preview()),
  Effect.scoped,
  Effect.provide(ActionDurableObject.layerStubClient(env.CHAT_ROOM.getByName(room))),
);
```

[chat-rooms/src/platform/room-stubs.ts](../examples/chat-rooms/src/platform/room-stubs.ts) is
that client, for the lobby. Its calls fail with `RpcClientError` as well as the actions' errors.

## Identity

Nothing authenticates a stub call: a stub is reachable only through a binding, so the caller is
the Worker or another object of the deployment. A caller acting for a principal forwards it,
in a header, with `RpcClient.withHeaders`, read by an `RpcMiddleware` of the group, or in a
payload field. A protected action of an `ActionRpc` binding authenticates every call from its
headers, as over a socket: forward the user's credential with `RpcClient.withHeaders`.

## On the wire

- The method takes a call's encoded request, a JSON string, and returns its encoded responses,
  a JSON string: Effect's `RpcSerialization.json`, as over the socket, one copy each way.
- Workers RPC limits a call's arguments and return value to 32 MiB, serialized. A request or
  an answer past it fails with the runtime's error, which the client reports as
  `RpcClientError`, a defect through `client`.
- A call's interruption does not reach the object: a stub call cannot be cancelled. Its answer
  is dropped.
