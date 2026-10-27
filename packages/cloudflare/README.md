# effect-actions-cloudflare

`@gjermundgaraba/effect-actions-cloudflare` serves Effect RPC from Cloudflare Durable Objects, over WebSockets the runtime holds while an object hibernates and over an object's stub, and calls it from a Worker: any plain `RpcGroup`, with no action at all, served by Effect's own `RpcServer`. [effect-actions](https://github.com/gjermundgaraba/effect-actions) bindings are the option: the same routes `ActionRpc.layer`, `ActionHttp.layer` and `ActionMcp.layerHttp` serve elsewhere, in an object, with events followed over its sockets, over MCP or by webhook across its hibernation. It is released with `@gjermundgaraba/effect-actions`, at the same version, and requires it.

```sh
pnpm add @gjermundgaraba/effect-actions @gjermundgaraba/effect-actions-cloudflare effect@~4.0.5
```

Its declarations name the Workers runtime's types, such as `Fetcher`: generate them with `wrangler types`, or install `@cloudflare/workers-types`, as a Worker project does.

Serve an Effect `RpcGroup` from an object, over WebSockets the runtime holds while it hibernates:

```ts
class ChatRoom extends ActionDurableObject.make({
  services: () =>
    Layer.mergeAll(layerSql, Layer.effect(Room)(ActionDurableObject.name)),
  routes: RpcServer.layer(RoomRpcs).pipe(
    Layer.provide(handlers),
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" }))
  ),
}) {}
```

Or serve actions there, authenticated, as `ActionRpc.layer` serves them elsewhere:

```ts
routes: ActionRpc.layer(RoomRpc, room).pipe(
  Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
  Layer.provide(authenticate),
),
```

Call an object's own API, an Effect `RpcGroup` it serves as its `calls`, from a Worker or another object with Cloudflare's own RPC, a new stub for each call, its declared errors typed:

```ts
Effect.gen(function* () {
  const lobby = yield* ActionDurableObject.client(LobbyCalls);

  return yield* lobby(() => env.CHAT_LOBBY.getByName("lobby")).previews();
});
```

Call an object's routes from a Worker with the core's own clients, through the stub:

```ts
ActionHttp.client(RoomHttp, { baseUrl: "https://room" }).pipe(
  Effect.provide(
    ActionDurableObject.layerHttpClient(env.CHAT_ROOM.getByName("design"))
  )
);
```

Its pages are in [docs/](docs/README.md), with an example, [chat-rooms](examples/chat-rooms/): one Durable Object per room, served over hibernating WebSockets, JSON and its stub, with an alarm and a Worker in front. In a project that installs it, both are in `node_modules/@gjermundgaraba/effect-actions-cloudflare/`.

MIT licensed.
