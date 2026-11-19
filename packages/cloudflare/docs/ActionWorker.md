# ActionWorker

Import `@gjermundgaraba/effect-actions-cloudflare/ActionWorker`. An application on Cloudflare is one Worker in front of Effect Cluster's Cloudflare runtime, where each entity id is one Durable Object. `ActionWorker.make(options)` is that whole Worker, made once, in the Worker's module: it names each entity once, with the layer serving it and the page's socket it accepts, builds the entities and the Worker's `routes` over `ActionCluster.layer` in one runtime per isolate, and returns the Worker's `fetch` and the four Durable Object classes to export. Its JSDoc holds the rules.

## Make the Worker

The example's Worker serves one entity, `Room`: its layer, a page's socket at `/rooms/<room>/rpc`, and the Worker's JSON and MCP routes, which reach every room through `ActionEntity.reaching`:

```ts example=chat-rooms/src/worker.ts
import * as ActionWorker from "@gjermundgaraba/effect-actions-cloudflare/ActionWorker";
import { Schema } from "effect";

import { DemoRoomName, MessagePosted } from "./chat/Chat.js";
import { Room } from "./entities.js";
import { rooms, workerRoutes } from "./routes.js";
import { protocolVersion, unsupportedProtocol } from "./Rpc.js";

const isRoom = Schema.is(DemoRoomName);

const worker = ActionWorker.make<Cloudflare.Env>({
  entities: [
    {
      entity: Room,
      layer: () => rooms,
      socket: {
        path: "/rooms/:id/rpc",
        id: (room) => (isRoom(room) ? room : undefined),
        actions: [MessagePosted],
        protocol: { version: protocolVersion, code: unsupportedProtocol },
      },
    },
  ],
  routes: () => workerRoutes,
});

export class ClusterEntity extends worker.ClusterEntity {}

export const {
  context,
  ClusterWorkflow,
  ClusterDurableQueue,
  ClusterSingleton,
} = worker;

export default { fetch: worker.fetch };
```

- **The four classes** are exported under the names Effect's runtime looks up, `ClusterEntity`, `ClusterWorkflow`, `ClusterDurableQueue` and `ClusterSingleton`, bound in `wrangler.jsonc` under `CLUSTER_ENTITY`, `CLUSTER_WORKFLOW`, `CLUSTER_QUEUE` and `CLUSTER_SINGLETON`, the names `make` reads from `env` unless `cluster` names others. [`chat-rooms/wrangler.jsonc`](../examples/chat-rooms/wrangler.jsonc) is the whole configuration: its one migration, `cluster-v1`, creates the four. An application replacing Durable Object classes of its own adds, before it, a step deleting them, which deletes every object of theirs and its data.
- **`ClusterEntity`** is Effect's class, recording each object's state for `ActionCluster.ObjectState` and serving the sockets of the entities that name one. A subclass, as the example's test Worker counts stub calls with, extends `worker.ClusterEntity`.
- **`context`** is the isolate's application, for a Worker of its own that calls an entity's client itself: [`chat-rooms/test/worker.test.ts`](../examples/chat-rooms/test/worker.test.ts) calls a room's client through it.

## Build once per isolate

Every object of the four classes, and every request but a socket's, waits for the one runtime `make` registers as the isolate's Durable Object initializer, so `make` runs once per isolate, from the Worker's module. A build still pending after 15 seconds is abandoned and another started, and the entities a stalled build registered refuse its replacement's: they run in the stalled build's services, or in none if it fails. So nothing slow, such as a migration or a remote fetch, builds in an entity's `layer` or in `routes`: run it in a request. `make`'s gotchas hold the rest.

## Judge every request, then route it

`policy`, a core `RequestPolicy`, judges each request's Host and Origin before anything, a socket's upgrade included, answering one it refuses 403 without building the application. Then an upgrade a socket's `path` and `id` match goes to the entity's object; every other request goes to `routes`, and one no route matches, such as a page, to `fallback`, the application's own answer: a static page, or a redirect it owns. `fallback` answers neither a route that answered 404 nor an upgrade no socket matched.

## Choose what each socket serves

A socket serves every action and event type of its entity's binding unless its `actions` lists some: the example's page only watches `MessagePosted`, so its socket serves that alone, and a call of another is answered `Unknown request tag`. A page built against the old list then misreads the server, so the list changes with `protocol.version`, as the example's moved to `"2"` when its socket stopped serving the room's actions. Following a room from a page, and what a socket costs: [ActionWorker-sockets.md](ActionWorker-sockets.md).
