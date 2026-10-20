# ActionDurableObject over the stub

Call an object's rpcs from its Worker, or from another object, with Cloudflare's own RPC: the
operations are declared once, as an Effect `RpcGroup` or an `ActionRpc` binding, served by the
object on one method, and called with a typed client whose errors are the declared ones. Its
routes are called through the same stub with the core's clients. Read
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

## Call an object's rpcs

`client(group)` makes one client, in the caller's `Scope`, for every object of a class, and
returns `(stubOf) => client`. Each call gets a new stub from `stubOf`, as it is sent, and fails
with the rpc's declared errors; a failure of the stub itself is a defect.

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
    Effect.map(ActionDurableObject.client(PluginRpcs), (plugin) =>
      Hosts.of({ plugin: (id) => plugin(() => env.PLUGIN.getByName(id)) }),
    ),
  );
}

startPane: ({ plugin }) => hosts.plugin(plugin).start(),
```

An application calling one object keeps its client for good, since each call reaches it
through a new stub: `const catalog = calls(() => env.CATALOG.getByName("catalog"))`, where
`calls` is what `client(CatalogRpcs)` succeeds with.

- `hosts.plugin(id).start()` is an `Effect<{ pane }, PluginNotFound | PluginHasNoPane>`.
- Never hold a stub: Cloudflare's error-handling guide says "Many exceptions leave the
  DurableObjectStub in a "broken" state", failing every later request through it with the
  same exception. `stubOf` is called for every call, so a call after a broken stub reaches the
  object through a new one, and the client keeps nothing per object across evictions.
- `stubOf` returns the stub `getByName` or `get(idFromString(id))` returns, and reads `env` as
  each call is sent. Only keys you accept should reach `getByName`: each name is another
  object. A factory that throws is a defect.
- A stub's failure, such as an object without `calls` or an answer past the platform's limit,
  is one its caller cannot recover from, so `client` makes it a defect. For Effect's own typing,
  with `RpcClientError` in every call's errors, call `RpcClient.make(group)` over
  `layerStubClient(stub)`.
- From another object, make the client in a startup service. Its factory reads the binding
  as each call is sent, from the `env` import of `cloudflare:workers` or from the `env` given
  to `make`'s `services` function, never as the module evaluates.
- `layerStubClient(stub)` holds the stub it was given: after its failure, provide the client
  a `layerStubClient` over a new stub.

An `ActionRpc` binding is called with its own client over the stub:

```ts
ActionRpc.client(RoomRpc).pipe(
  Effect.flatMap((client) => client.preview()),
  Effect.scoped,
  Effect.provide(ActionDurableObject.layerStubClient(env.CHAT_ROOM.getByName(room))),
);
```

[chat-rooms/src/platform/room-stubs.ts](../examples/chat-rooms/src/platform/room-stubs.ts) is
that client, for the lobby, over a new stub for every call. Its calls fail with
`RpcClientError` as well as the actions' errors.

## Errors that name the object

An object reached by `getByName` knows its name, `State`'s `id.name`. Make the name a startup
service, dying without one, as
[chat-rooms/src/platform/object-name.ts](../examples/chat-rooms/src/platform/object-name.ts)
makes its `Room`, and build the error from that service in the handler: a `PluginName` service
gives `new PluginNotFound({ plugin: name })`, with nothing more from the caller. An object
reached by `get(idFromString(id))` has no name: its caller sends the key in the payload, for
the error to name.

## Call an object's routes

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
  that call alone.

## Identity

Nothing authenticates a stub call: a stub is reachable only through a binding, so the caller is
the Worker or another object of the deployment. A caller acting for a principal forwards it,
in a header, with `RpcClient.withHeaders`, read by an `RpcMiddleware` of the group, or in a
payload field. A protected action of an `ActionRpc` binding authenticates every call from its
headers, as over a socket: forward the user's credential with `RpcClient.withHeaders`.

## On the wire

- The method takes an array of a call's messages, `RpcMessage.FromClientEncoded`, and returns
  its responses, `FromServerEncoded`, as values Workers RPC's structured clone copies, never a
  JSON string: each schema's plain form, `Schema.toCodecIso`. A `Date`, bytes, `undefined` and
  an `Error` defect cross as themselves; an `Option`, an exit and a tagged error as their
  tagged objects, a `Map` and a `Set` as arrays.
- A schema with no JSON form, such as `Schema.instanceOf(Date)`, works over the stub, not over
  the socket. An `ActionRpc` binding's values cross as JSON over either.
- A value the clone refuses, such as a class instance in a `Schema.Unknown`, fails the whole
  call with workerd's `DataCloneError`, which the client reports as `RpcClientError`
  ([ActionDurableObject-failures.md](ActionDurableObject-failures.md)).
- Workers RPC limits a call's arguments and return value to 32 MiB, serialized. A request or
  an answer past it fails with the runtime's error, which the client reports as
  `RpcClientError`, a defect through `client`.
- A call's interruption does not reach the object: a stub call cannot be cancelled. Its answer
  is dropped.
