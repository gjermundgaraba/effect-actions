# effect-actions-cloudflare

`@gjermundgaraba/effect-actions-cloudflare` serves
[effect-actions](https://github.com/gjermundgaraba/effect-actions) from Cloudflare Durable
Objects, and calls them from a Worker. It is released with `@gjermundgaraba/effect-actions`, at
the same version, and requires it.

```sh
pnpm add @gjermundgaraba/effect-actions @gjermundgaraba/effect-actions-cloudflare effect@~4.0.4
```

Its declarations name the Workers runtime's types, such as `Fetcher`: generate them with
`wrangler types`, or install `@cloudflare/workers-types`, as a Worker project does.

Serve actions from an object, over WebSockets the runtime holds while it hibernates:

```ts
class ChatRoom extends ActionDurableObject.make({
  services: Layer.mergeAll(layerSql, layerRoom),
  routes: ActionRpc.layer(RoomRpc, room).pipe(
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
    Layer.provide(authenticate),
  ),
  calls: RpcServer.layer(RoomCalls).pipe(Layer.provide(calls)),
}) {}
```

Call an object's own API, an Effect `RpcGroup` it serves as its `calls`, from a Worker or
another object with Cloudflare's own RPC, a new stub for each call, its declared errors typed:

```ts
Effect.gen(function* () {
  const room = yield* ActionDurableObject.client(RoomCalls);

  return yield* room(() => env.CHAT_ROOM.getByName("design")).latestAt();
});
```

Call an object's routes from a Worker with the core's own clients, through the stub:

```ts
ActionHttp.client(RoomHttp, { baseUrl: "https://room" }).pipe(
  Effect.provide(ActionDurableObject.layerHttpClient(env.CHAT_ROOM.getByName("design"))),
);
```

Its pages are in [docs/](docs/README.md), with an example, [chat-rooms](examples/chat-rooms/):
one Durable Object per room, served over hibernating WebSockets, JSON and its stub, with an
alarm and a Worker in front. In a project that installs it, both are in
`node_modules/@gjermundgaraba/effect-actions-cloudflare/`.

MIT licensed.
