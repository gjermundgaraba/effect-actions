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
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";

export class ChatRoom extends ActionDurableObject.make({
  routes: ActionRpc.layer(Rpc, implementations).pipe(
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
    Layer.provide(authenticate),
  ),
}) {}
```

Serve an object's own API as an Effect `RpcGroup` over its stub, and call it from a Worker or
another object with Cloudflare's own RPC, its declared errors typed:

```ts
export class PluginHost extends ActionDurableObject.make({
  calls: RpcServer.layer(PluginRpcs).pipe(Layer.provide(pluginHandlers)),
}) {}

const plugin =
  yield * ActionDurableObject.client(PluginRpcs, (id: string) => env.PLUGIN.getByName(id));
const { pane } = yield * plugin("notes").start();
```

Call an object's routes from a Worker with the core's own clients, through the stub:

```ts
ActionHttp.client(Http, { baseUrl: "https://object" }).pipe(
  Effect.provide(ActionDurableObject.layerHttpClient(env.ROOM.getByName("lobby"))),
);
```

Its pages are in [docs/](docs/README.md), with an example, [chat-rooms](examples/chat-rooms/):
one Durable Object per room, served over hibernating WebSockets, JSON and its stub, with an
alarm and a Worker in front. In a project that installs it, both are in
`node_modules/@gjermundgaraba/effect-actions-cloudflare/`.

MIT licensed.
