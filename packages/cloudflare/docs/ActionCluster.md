# ActionCluster

Import `@gjermundgaraba/effect-actions-cloudflare/ActionCluster`. An application on Cloudflare declares its entities with the core's `ActionEntity`, as on any cluster runtime, and runs them on `@effect/platform-cloudflare`'s Cloudflare runtime: each entity id is one Durable Object, named `CloudflareCluster.encodeName(type, id)` in the `ClusterEntity` namespace, holding the entity's mailbox, its stores and its events in the object's own SQLite database. `ActionCluster.layer(options)` is that runtime's layer, `CloudflareCluster.layer`, with one change: its entity clients send a volatile call's headers as the caller set them, so a credential `ActionEntity.reaching` forwards reaches the entity, which authenticates it, and a persisted tell's redacted, as its envelope is kept at rest. Its JSDoc holds the rules.

## Deploy the four classes

The runtime's four Durable Object classes, `ClusterEntity`, `ClusterWorkflow`, `ClusterDurableQueue` and `ClusterSingleton`, are exported from the Worker's module, bound in `wrangler.jsonc` and created by a SQLite migration; `ActionCluster.layer` takes the four namespaces. The example's `ClusterEntity` is `ActionClusterEntity.make`'s class, which runs the same entity program as Effect's and serves its rooms' sockets besides, in [ActionClusterEntity.md](ActionClusterEntity.md); an application serving no sockets exports `ActionClusterEntity.ClusterEntity`, Effect's class recording each object's state for `ActionCluster.ObjectState`, or Effect's own where no entity reads that state. The example's [`chat-rooms/wrangler.jsonc`](../examples/chat-rooms/wrangler.jsonc) is the whole configuration: its one migration, `cluster-v1`, creates the four, and a new application writes the same. One replacing Durable Object classes of its own keeps its deployed migrations and adds, before the one creating the four, a step deleting those classes, which deletes every object of theirs and its stored data.

The module's default export is `ActionCluster.handler(initialize, { sockets })`, the Worker's `fetch`: it hands a page's upgrade at `/rooms/<room>/rpc` to the room's object without waiting on the initializer, its route's `id` admitting a demo room alone, and answers every other request with the application's routes. Its JSDoc holds the rules.

```ts example=chat-rooms/src/worker.ts
import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import * as ActionClusterEntity from "@gjermundgaraba/effect-actions-cloudflare/ActionClusterEntity";
import { Schema } from "effect";

import { initialize } from "./application.js";
import { DemoRoomName } from "./chat/Chat.js";
import { Room } from "./entities.js";
import { protocolVersion, unsupportedProtocol } from "./Rpc.js";

export {
  ClusterDurableQueue,
  ClusterSingleton,
  ClusterWorkflow,
} from "@effect/platform-cloudflare/CloudflareDurableObjects";

export class ClusterEntity extends ActionClusterEntity.make({
  initialize,
  sockets: [Room],
  protocol: { version: protocolVersion, code: unsupportedProtocol },
}) {}

const isRoom = Schema.is(DemoRoomName);

export default ActionCluster.handler(initialize, {
  sockets: {
    entityNamespace: (env) => env.CLUSTER_ENTITY,
    routes: [
      {
        entity: Room,
        path: "/rooms/:id/rpc",
        id: (room) => (isRoom(room) ? room : undefined),
      },
    ],
  },
});
```

## Boot once per isolate

Every object of the four classes, and the Worker's handler, waits for the one initializer the isolate registers. Register exactly one, from the Worker's module: `ActionClusterEntity.register(application)`, which registers `ActionCluster.initializer(application)` with `CloudflareDurableObjects.setInitializer` and returns the `initialize` that `handler` and `ActionClusterEntity.make` take; it is `ActionClusterEntity`'s, since `setInitializer`'s module loads only in a Worker, where `ActionCluster` loads in Node too. The initializer builds the application, the entity layers and the Worker's routes with `ActionCluster.layer` beneath them, over `HttpRouter.layer`, and keeps the first runtime to finish for the isolate, leaving a later one alive beside it. A build still pending after 15 seconds is abandoned and another started, and the entities a stalled build registered refuse its replacement's, so they run in the stalled build's services, or in none if it fails, and nothing slow, such as a migration or a remote fetch, builds above `ActionCluster.layer`, as `quickOnceTheClusterIsBuilt` names: run it before, or in a request. Their JSDoc holds the rules.

```ts example=chat-rooms/src/application.ts
import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import * as ActionClusterEntity from "@gjermundgaraba/effect-actions-cloudflare/ActionClusterEntity";
import { Layer } from "effect";
import { HttpServer } from "effect/http";

import { Room } from "./entities.js";
import { entities, workerRoutes } from "./routes.js";

const quickOnceTheClusterIsBuilt = Layer.mergeAll(
  entities,
  workerRoutes.pipe(Layer.provide(HttpServer.layerServices))
);

const application = (env: Cloudflare.Env) =>
  quickOnceTheClusterIsBuilt.pipe(
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

export const initialize = ActionClusterEntity.register(application);
```

## Serve the entities from the Worker

The Worker serves every entity's actions and events itself, `ActionHttp.layer(RoomHttp, ActionEntity.reaching(Room))`, each call sent to the object its input's key names, and one MCP endpoint for all of them, `requestScoped`, in [`chat-rooms/src/routes.ts`](../examples/chat-rooms/src/routes.ts). Each entity id builds its own stores as it activates, in `ActionEntity.layer`'s `services`: there, `ActionCluster.Sql` is the object's own database, `@effect/platform-cloudflare`'s `DurableObjectSqlClient`, and `ActionCluster.layerObject` provides it as `SqlClient` with `Stored.layerEvents` over it, beneath the example's message store and webhooks; built outside an activation, it dies. `ActionClusterEntity.register` and `ActionCluster.Sql` wrap the runtime's experimental APIs, so an application needs no lint exception for them. A room reads its name from `Entity.CurrentAddress` the same way.

## Answer a call made through an entity's client

A Worker route that calls an entity's client itself, `Entity.client`, `ActionEntity.client` or `ActionEntity.nativeClient`, outside `ActionEntity.reaching`, answers a failed call's cause with `ActionCluster.failureResponse(cause)`: a 503 with `Retry-After: 1` where the entity could not be reached or did not answer in time, a 499 where the request's client went away, and otherwise a 500, the cause logged. Its JSDoc holds the rules.

## Read the object's own state

An entity that needs more of its Durable Object than its database, such as a library taking the object's `storage`, or `waitUntil` to keep the object alive for work that outlives the call that started it, reads `ActionCluster.ObjectState.orDie`: the object's `id`, `storage`, `waitUntil` and `abort`, in its build, its `services`, a handler or a fiber either forks, on an object of `ActionClusterEntity.make`'s class or `ActionClusterEntity.ClusterEntity`, which record it as the object is made. A library written with Promises that takes the object's SQLite storage, as `{ sql, transaction }`, gets `state.database`, one object per build of the entity's handlers, whose `transaction` takes the gate the runtime's mailbox writes wait on. Two traps are the runtime's, and its JSDoc holds them with the rest: a transaction opened on `storage` directly skips that gate, so another call's reply can be lost to its rollback; and the runtime owns the alarm, so `storage.setAlarm` replaces what it scheduled.

## Deliver a room's events by webhook

A protected event the Worker serves through `ActionEntity.reaching` is delivered by webhook from the entity its input names, as the core's `docs/ActionEntity.md` says. Each room builds `Webhook.layer` in its `services`, with `persist`, in [`chat-rooms/src/routes.ts`](../examples/chat-rooms/src/routes.ts), over a table of its own in the object's database and fetch's client, in [`chat-rooms/src/platform/webhook-delivery.ts`](../examples/chat-rooms/src/platform/webhook-delivery.ts), and `Login` names a `schema`. `resolveCallbacks: false` checks a literal callback address alone, as a Worker has no resolver. Each retry wait is a tell on the object's alarm, so an evicted room is built again to deliver. `MessagePosted` is `notified`, so a subscribed room asks it again only when a post notifies it, and hibernates while idle. [`chat-rooms/test/webhooks.test.ts`](../examples/chat-rooms/test/webhooks.test.ts) answers the deliveries through Miniflare's `outboundService`, given in `vite.config.ts`.

## Test on workerd

`@cloudflare/vitest-plugin` runs the Worker, its four classes and their storage in workerd; [`chat-rooms/test/worker.test.ts`](../examples/chat-rooms/test/worker.test.ts), with [`test/support.ts`](../examples/chat-rooms/test/support.ts), calls the Worker's `fetch` through `FetchHttpClient`, reads an object's tables with `runInDurableObject`, evicts one with `evictDurableObject`, and plants a failure with a SQLite trigger. `deliverNow` delivers a scheduled wake early by moving its `deliver_at` in `cluster_messages` and running the object's alarm with `runDurableObjectAlarm`: those columns of `cluster_messages`, `deliver_at`, `processed` and `envelope`, are the runtime's private schema, not its API, so a test reading them is rechecked on an upgrade of `@effect/platform-cloudflare`.

## What differs from another cluster runtime

- **The runtime owns each object's alarm**, waking it for a scheduled tell, a replay or `Entity.keepAlive`: an application sets none of its own, though `ActionCluster.ObjectState`'s `storage` would let it.
- **An object is built per wake.** The runtime evicts an idle object, and the next request builds the entity again, `services` and builders included: anything in memory is gone, the database stays.
