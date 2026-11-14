# effect-actions-cloudflare

`@gjermundgaraba/effect-actions-cloudflare` runs [effect-actions](https://github.com/gjermundgaraba/effect-actions) entities on Cloudflare Durable Objects through Effect Cluster: each entity id is one object, with its own SQLite database, and a Worker in front serves every entity's actions and events over JSON and MCP. It is released with `@gjermundgaraba/effect-actions`, at the same version, and requires it and `@effect/platform-cloudflare`.

```sh
pnpm add @gjermundgaraba/effect-actions @gjermundgaraba/effect-actions-cloudflare @effect/platform-cloudflare@~4.1.4 effect@~4.1.4
```

Its declarations name the Workers runtime's types: generate them with `wrangler types`, or install `@cloudflare/workers-types`, as a Worker project does.

Declare an entity with the core's `ActionEntity`, keyed by its input:

```ts
const Room = ActionEntity.make("Room", RoomRpc, {
  key: { readMessages: byRoom, postMessage: byRoom },
});
```

Run it on Durable Objects, under the cluster layer whose clients send a caller's credential intact, and serve it from the Worker:

```ts
Layer.mergeAll(
  ActionEntity.layer(Room, messages, { services: roomServices }),
  ActionHttp.layer(RoomHttp, ActionEntity.reaching(Room))
).pipe(
  Layer.provideMerge(
    ActionCluster.layer({
      entities: [Room],
      entityNamespace: env.CLUSTER_ENTITY,
      workflowNamespace: env.CLUSTER_WORKFLOW,
      queueNamespace: env.CLUSTER_QUEUE,
      singletonNamespace: env.CLUSTER_SINGLETON,
    })
  )
);
```

A page follows an entity's events over a WebSocket to the entity's own object, which the runtime keeps open while the object hibernates, through the class the Worker exports in place of Effect's `ClusterEntity`:

```ts
class ClusterEntity extends ActionClusterEntity.make({
  initialize,
  sockets: [Room],
  protocol: { version: "1", code: 4000 },
}) {}
```

The package owns the Worker's wiring: one initializer builds the application once per isolate, and the Worker's handler hands a page's upgrade to its room's object and serves every other request from the application's routes:

```ts
const initialize = CloudflareDurableObjects.setInitializer(
  ActionCluster.initializer(application)
);

ActionCluster.handler(initialize, {
  sockets: {
    entityNamespace: (env) => env.CLUSTER_ENTITY,
    routes: [{ entity: Room, path: /^\/rooms\/(?<id>[^/]+)\/rpc$/u }],
  },
});
```

Its pages are in [docs/](docs/README.md), with an example, [chat-rooms](examples/chat-rooms/): a room per entity, a page's socket to its room, its posts by webhook, and a Worker in front serving JSON and MCP. In a project that installs it, both are in `node_modules/@gjermundgaraba/effect-actions-cloudflare/`.

MIT licensed.
