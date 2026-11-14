# ActionCluster

Import `@gjermundgaraba/effect-actions-cloudflare/ActionCluster`. An application on Cloudflare declares its entities with the core's `ActionEntity`, as on any cluster runtime, and runs them on `@effect/platform-cloudflare`'s Cloudflare runtime: each entity id is one Durable Object, named `CloudflareCluster.encodeName(type, id)` in the `ClusterEntity` namespace, holding the entity's mailbox, its stores and its events in the object's own SQLite database. `ActionCluster.layer(options)` is that runtime's layer, `CloudflareCluster.layer`, with one change: its entity clients send a volatile call's headers as the caller set them, so a credential `ActionEntity.reaching` forwards reaches the entity, which authenticates it, and a persisted tell's redacted, as its envelope is kept at rest. Its JSDoc holds the rules.

## Deploy the four classes

The runtime's four Durable Object classes, `ClusterEntity`, `ClusterWorkflow`, `ClusterDurableQueue` and `ClusterSingleton`, are exported from the Worker's module, bound in `wrangler.jsonc` and created by a SQLite migration; `ActionCluster.layer` takes the four namespaces. The example's `ClusterEntity` is `ActionClusterEntity.make`'s class, which runs the same entity program as Effect's and serves its rooms' sockets besides, in [ActionClusterEntity.md](ActionClusterEntity.md); an application serving no sockets re-exports Effect's own. The example's [`chat-rooms/wrangler.jsonc`](../examples/chat-rooms/wrangler.jsonc) is the whole configuration: its one migration, `cluster-v1`, creates the four, and a new application writes the same. One replacing classes of its own, as the earlier chat-rooms' `ChatRoom` and `ChatLobby`, keeps its deployed migrations and adds, before the one creating the four, a step deleting those classes, which deletes every object of theirs and its stored data.

```ts example=chat-rooms/src/worker.ts
import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import * as ActionClusterEntity from "@gjermundgaraba/effect-actions-cloudflare/ActionClusterEntity";
import { Context, Schema } from "effect";
import type { Scope } from "effect";
import { HttpEffect, HttpRouter } from "effect/http";
import type { HttpServerRequest } from "effect/http";

import { initialize } from "./application.js";
import type { Application } from "./application.js";
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

const roomSocket = /^\/rooms\/(?<room>[^/]+)\/rpc$/u;

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    const room = roomSocket.exec(new URL(request.url).pathname)?.groups?.room;

    if (room !== undefined && isRoom(room)) {
      return await env.CLUSTER_ENTITY.getByName(
        CloudflareCluster.encodeName(Room.type, room)
      ).fetch(request);
    }

    const context = await initialize(env);

    return await HttpEffect.toWebHandlerWith<
      Application,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >(context)(Context.get(context, HttpRouter.HttpRouter).asHttpEffect())(
      request
    );
  },
} satisfies ExportedHandler<Cloudflare.Env>;
```

## Boot once per isolate

Every object of the four classes, and the Worker's `fetch`, waits for the one initializer `CloudflareDurableObjects.setInitializer` registers, which builds the application: the entity layers, the Worker's routes and `ActionCluster.layer` beneath them, in one `ManagedRuntime`. Register exactly one, from the Worker's module. Each call builds a fresh runtime, disposing it when it fails, and the first to finish is kept for the isolate: the build must finish within 15 seconds, as one still pending is treated as abandoned and a waiting object calls the initializer again, and a stalled build finishing after its replacement is disposed. Its entities' registrations go with it: the stalled build registered them first, so its replacement's were refused, and the kept runtime then serves no entity. So nothing slow, such as a migration or a remote fetch, builds after `ActionCluster.layer`, as `quickOnceTheClusterIsBuilt` names: run it before, or in a request.

```ts example=chat-rooms/src/application.ts
import * as CloudflareDurableObjects from "@effect/platform-cloudflare/CloudflareDurableObjects";
import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import { Layer, ManagedRuntime } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { Room } from "./entities.js";
import { entities, workerRoutes } from "./routes.js";

const quickOnceTheClusterIsBuilt = Layer.mergeAll(
  entities,
  workerRoutes.pipe(
    Layer.provideMerge(HttpRouter.layer),
    Layer.provide(HttpServer.layerServices)
  )
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

export type Application = Layer.Success<ReturnType<typeof application>>;

let running: ManagedRuntime.ManagedRuntime<Application, never> | undefined;

export const initialize = CloudflareDurableObjects.setInitializer(
  async (env: Cloudflare.Env) => {
    if (running !== undefined) {
      return await running.context();
    }

    const runtime = ManagedRuntime.make(Layer.orDie(application(env)));

    const context = await runtime.context().catch(async (error: unknown) => {
      await runtime.dispose();

      throw error;
    });

    running ??= runtime;

    if (running === runtime) {
      return context;
    }

    await runtime.dispose();

    return await running.context();
  }
);
```

## Serve the entities from the Worker

The Worker serves every entity's actions and events itself, `ActionHttp.layer(RoomHttp, ActionEntity.reaching(Room))`, each call sent to the object its input's key names, and one MCP endpoint for all of them, `requestScoped`, in [`chat-rooms/src/routes.ts`](../examples/chat-rooms/src/routes.ts). Each entity id builds its own stores as it activates, in `ActionEntity.layer`'s `services`: there, `CloudflareCluster.DurableObjectSqlClient` is the object's own database, which `Stored.layerEvents` and the example's message store read; built outside an activation, it dies. A room reads its name from `Entity.CurrentAddress` the same way.

## Deliver a room's events by webhook

A protected event the Worker serves through `ActionEntity.reaching` is delivered by webhook from the entity its input names, as the core's `docs/ActionEntity.md` says. Each room builds `Webhook.layer` in its `services`, with `persist` and `ActionEntity.layerClock`, in [`chat-rooms/src/routes.ts`](../examples/chat-rooms/src/routes.ts), over a table of its own in the object's database and fetch's client, in [`chat-rooms/src/platform/webhook-delivery.ts`](../examples/chat-rooms/src/platform/webhook-delivery.ts), and `Login` names a `principal` and a `schema`. `resolveCallbacks: false` checks a literal callback address alone, as a Worker has no resolver. A retry wait of 10 seconds or more is a tell on the object's alarm, so an evicted room is built again to deliver. `MessagePosted` is `notified`, so a subscribed room asks it again only when a post notifies it, and hibernates while idle. [`chat-rooms/test/webhooks.test.ts`](../examples/chat-rooms/test/webhooks.test.ts) answers the deliveries through Miniflare's `outboundService`, given in `vite.config.ts`.

## Test on workerd

`@cloudflare/vitest-plugin` runs the Worker, its four classes and their storage in workerd; [`chat-rooms/test/worker.test.ts`](../examples/chat-rooms/test/worker.test.ts), with [`test/support.ts`](../examples/chat-rooms/test/support.ts), calls the Worker's `fetch` through `FetchHttpClient`, reads an object's tables with `runInDurableObject`, evicts one with `evictDurableObject`, and plants a failure with a SQLite trigger. `deliverNow` delivers a scheduled wake early by moving its `deliver_at` in `cluster_messages` and running the object's alarm with `runDurableObjectAlarm`: those columns of `cluster_messages`, `deliver_at`, `processed` and `envelope`, are the runtime's private schema, not its API, so a test reading them is rechecked on an upgrade of `@effect/platform-cloudflare`.

## What differs from another cluster runtime

- **The runtime owns each object's alarm**, waking it for a scheduled tell, a replay or `Entity.keepAlive`: an application sets none of its own.
- **An object is built per wake.** The runtime evicts an idle object, and the next request builds the entity again, `services` and builders included: anything in memory is gone, the database stays.
