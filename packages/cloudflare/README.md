# effect-actions-cloudflare

`@gjermundgaraba/effect-actions-cloudflare` runs [effect-actions](https://github.com/gjermundgaraba/effect-actions) entities on Cloudflare Durable Objects through Effect Cluster: each entity id is one object, with its own SQLite database, and a Worker in front serves every entity's actions and events over JSON and MCP. It is released with `@gjermundgaraba/effect-actions`, at the same version, and requires it and `@effect/platform-cloudflare`.

```sh
pnpm add @gjermundgaraba/effect-actions @gjermundgaraba/effect-actions-cloudflare @effect/platform-cloudflare@~4.1.4 effect@~4.1.4
```

Its declarations name the Workers runtime's types: generate them with `wrangler types`, or install `@cloudflare/workers-types`, as a Worker project does.

Declare an entity with the core's `ActionEntity`, from its actions and event types, keyed by its input:

```ts
const Room = ActionEntity.make("Room", [...Messages, MessagePosted], {
  authentication: Login,
  key: ({ room }) => room,
});
```

Make the Worker once, naming each entity with the layer serving it and the page's socket it accepts, and export what it returns: the four cluster classes and `McpEndpoint`, and its `fetch`, which judges each request's Host and Origin first, hands a page's upgrade to its room's object, sends MCP requests to the endpoint `mcp` serves from Durable Objects of its own, and answers the rest with the routes, or a page with `fallback`:

```ts
const worker = ActionWorker.make<Env>({
  entities: [
    {
      entity: Room,
      layer: () =>
        ActionEntity.layer(Room, messages, { services: roomServices }),
      socket: {
        path: "/rooms/:id/rpc",
        actions: [MessagePosted],
        protocol: { version: "1", code: 4000 },
      },
    },
  ],
  routes: () => ActionHttp.layer(RoomHttp, ActionEntity.reaching(Room)),
  mcp: {
    layer: () => ActionMcp.layerHttp(ActionEntity.reaching(Room), mcpOptions),
  },
  policy: (env) => RequestPolicy.make({ publicUrl: new URL(env.PUBLIC_URL) }),
  fallback: (request) => page(request),
});

export const {
  ClusterEntity,
  ClusterWorkflow,
  ClusterDurableQueue,
  ClusterSingleton,
  McpEndpoint,
} = worker;
export default { fetch: worker.fetch };
```

Its pages are in [docs/](docs/README.md), with an example, [chat-rooms](examples/chat-rooms/): a room per entity, a page's socket to its room, its posts by webhook, and a Worker in front serving JSON and MCP. In a project that installs it, both are in `node_modules/@gjermundgaraba/effect-actions-cloudflare/`.

MIT licensed.
