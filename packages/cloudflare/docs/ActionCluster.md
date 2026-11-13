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

export { RoomsEntrypoint } from "./rooms-entrypoint.js";

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

import { Lobby, Room } from "./entities.js";
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
        entities: [Room, Lobby],
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

The Worker serves every entity's actions and events itself, `ActionHttp.layer(RoomHttp, ActionEntity.reaching(Room))`, each call sent to the object its input's key names, and one MCP endpoint for all of them, `requestScoped`, in [`chat-rooms/src/routes.ts`](../examples/chat-rooms/src/routes.ts). Each entity id builds its own stores as it activates, in `ActionEntity.layer`'s `services`: there, `CloudflareCluster.DurableObjectSqlClient` is the object's own database, which `Stored.layerEvents`, `Stored.layerIdempotency` over `KeyValueStore.layerSql` and the example's message store read; built outside an activation, it dies. A room reads its name from `Entity.CurrentAddress` the same way.

Another Worker reaches the entities through a `WorkerEntrypoint` calling `ActionEntity.client` in the booted runtime: [`chat-rooms/src/rooms-entrypoint.ts`](../examples/chat-rooms/src/rooms-entrypoint.ts).

## Deliver a room's events by webhook

A protected event the Worker serves through `ActionEntity.reaching` is delivered by webhook from the entity its input names, as the core's `docs/ActionEntity.md` says. Each room builds `Webhook.layer` in its `services`, with `persist` and `ActionEntity.layerClock`, in [`chat-rooms/src/routes.ts`](../examples/chat-rooms/src/routes.ts), over a table of its own in the object's database and fetch's client, in [`chat-rooms/src/platform/webhook-delivery.ts`](../examples/chat-rooms/src/platform/webhook-delivery.ts), and `Login` names a `principal` and a `schema`. `resolveCallbacks: false` checks a literal callback address alone, as a Worker has no resolver. A retry wait of 10 seconds or more is a tell on the object's alarm, so an evicted room is built again to deliver. A room subscribed to a check source's event, as `MessagePosted` is, asks the source again on a timer after its 2-second `nextPoll`, which keeps the object from hibernating while the subscription lives; it hibernates once the subscription expired. A `nextPoll` of 10 seconds or more is a wake instead, one row each. [`chat-rooms/test/webhooks.test.ts`](../examples/chat-rooms/test/webhooks.test.ts) answers the deliveries through Miniflare's `outboundService`, given in `vite.config.ts`.

## Schedule a tell

An entity's own work, outside any caller's request, is a native rpc of its own: declared in `ActionEntity.make`'s `rpcs`, handled by `ActionEntity.layer`'s `rpcs`, an `Entity.HandlersFrom` built as the entity activates, in [`chat-rooms/src/chat/handlers.ts`](../examples/chat-rooms/src/chat/handlers.ts), and sent through `Entity.client`. One annotated `ClusterSchema.Persisted` and sent as a tell, `{ discard: true }`, is a row of the object's mailbox, run after the call sending it ends where that call holds the entity's one slot, `concurrency: 1`, the default, and no `Rpc.fork`, and run again after a crash; the Cloudflare runtime frees the slot too while a stream's frame waits for its client's acknowledgement. A payload naming `DeliverAt` is delivered at that time, by the object's alarm; a `PrimaryKey` makes every tell of one key one delivery for the object's life, a processed one included, so a room schedules one expiry an hour's window, and the retries due in one minute share one.

```ts example=chat-rooms/src/chat/Tells.ts
import { DateTime, PrimaryKey, Schema } from "effect";
import { ClusterSchema, DeliverAt } from "effect/cluster";
import { Rpc, RpcGroup } from "effect/rpc";

const hour = 60 * 60 * 1000;

export const day = 24 * hour;

export const windowOf = (postedAt: number) =>
  Math.ceil((postedAt + day) / hour) * hour;

export class Expire extends Schema.Class<
  Expire,
  { readonly brand: unique symbol }
>("chat-rooms/Expire")({ at: Schema.Int }) {
  [PrimaryKey.symbol]() {
    return String(this.at);
  }

  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at);
  }
}

export const Task = Schema.Literals(["expire", "tellLobby"]);

export type Task = typeof Task.Type;

export class Retry extends Schema.Class<
  Retry,
  { readonly brand: unique symbol }
>("chat-rooms/Retry")({ task: Task, at: Schema.Int, attempt: Schema.Int }) {
  [PrimaryKey.symbol]() {
    return `${this.task}-${this.at}`;
  }

  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at);
  }
}

export const RoomTells = RpcGroup.make(
  Rpc.make("expire", { payload: Expire }),
  Rpc.make("tellLobby"),
  Rpc.make("retry", { payload: Retry })
).annotateRpcs(ClusterSchema.Persisted, true);
```

A volatile call's change, such as a post, sends its follow-ups as persisted tells before it writes: they run after its handler ends, as the room serves one call at a time (`concurrency: 1` in [`chat-rooms/src/routes.ts`](../examples/chat-rooms/src/routes.ts)) and no handler answers through `Rpc.fork`, so each reads what the change wrote; a crash after the write replays them, and a failure before it runs them on an unchanged room, which changes nothing. The room asks the lobby at each change by a volatile call, `roomChanged`, in its one slot, waiting a second for the answer and a second more at most for the lobby to take its interruption, so while the lobby takes no call, or answers late, as an ask queued behind other rooms' in the lobby's one slot does, a call reaching the room behind n asks waits up to 2n seconds; a lobby that fails or answers late is asked again by the next change or a later `retry`, each reading the room's latest again. `roomChanged` is annotated `ClusterSchema.Uninterruptible` for the server, so the lobby records a change the room stopped waiting for, and records it and notifies its followers in one transaction, so a retry never finds the change recorded and its notification lost.

```ts example=chat-rooms/src/platform/cluster-clients.ts
import { Effect, Layer } from "effect";
import { Entity } from "effect/cluster";

import { RoomMailbox } from "../chat/mailbox.js";
import { Expire, Retry } from "../chat/Tells.js";
import { Lobby, Room } from "../entities.js";
import { LobbyClient } from "../lobby/client.js";

export const layerRoomMailbox = Layer.effect(RoomMailbox)(
  Effect.gen(function* () {
    const { entityId } = yield* Entity.CurrentAddress;
    const rooms = yield* Room.client;
    const room = rooms(entityId);

    return RoomMailbox.of({
      expire: (at) =>
        Effect.orDie(room.expire(new Expire({ at }), { discard: true })),
      tellLobby: Effect.orDie(room.tellLobby(undefined, { discard: true })),
      retry: (task, at, attempt) =>
        Effect.orDie(
          room.retry(new Retry({ task, at, attempt }), { discard: true })
        ),
    });
  })
);

export const layerLobbyClient = Layer.effect(LobbyClient)(
  Effect.gen(function* () {
    const lobbies = yield* Lobby.client;
    const lobby = lobbies("lobby");

    return LobbyClient.of({
      roomChanged: (change) => Effect.orDie(lobby.roomChanged(change)),
    });
  })
);
```

A tell is processed once its handler ends, a failure included, and replayed only after the object crashed mid-run: a handler whose work fails logs the cause and sends itself a later `retry`, 1, 2 and 4 minutes later and so on, at most an hour apart, as [`chat-rooms/src/retry.ts`](../examples/chat-rooms/src/retry.ts) does. The retries stop short of success where scheduling one fails, such as on `MailboxFull`, which is logged, or where the entity cannot be built when one is delivered, which the runtime then marks processed without running it: a later change starts the task again, the next post of another hour's window its expiry and any change its tell to the lobby, so an idle room keeps a day-old message, or the lobby its old preview, until then. Delivery is at least once, in no set order: the room counts its changes in its own database, and the lobby keeps a preview only of a version above the one it holds, in [`chat-rooms/src/platform/sql-previews.ts`](../examples/chat-rooms/src/platform/sql-previews.ts). Every processed tell keeps its row in the object's `cluster_messages`, which the runtime never prunes: a room keeps one expiry row an hour, a failing task one retry row a minute at most, and one lobby tell row for each post or delete, refused or failed ones included, and for each run of an expiry, its retries included.

## Test on workerd

`@cloudflare/vitest-plugin` runs the Worker, its four classes and their storage in workerd; [`chat-rooms/test/worker.test.ts`](../examples/chat-rooms/test/worker.test.ts), with [`test/support.ts`](../examples/chat-rooms/test/support.ts), calls the Worker's `fetch` through `FetchHttpClient`, reads an object's tables with `runInDurableObject`, holds an object's every call with `state.blockConcurrencyWhile` inside it, as a lobby that takes no call, evicts one with `evictDurableObject`, and delivers a scheduled tell early by moving its `deliver_at` in `cluster_messages` and running the object's alarm with `runDurableObjectAlarm`. Those columns of `cluster_messages`, `deliver_at`, `processed` and `envelope`, are the runtime's private schema, not its API: a test reading them is rechecked on an upgrade of `@effect/platform-cloudflare`.

## What differs from another cluster runtime

- **The runtime owns each object's alarm**, waking it for a scheduled tell, a replay or `Entity.keepAlive`: an application sets none of its own.
- **An object is built per wake.** The runtime evicts an idle object, and the next request builds the entity again, `services` and builders included: anything in memory is gone, the database stays.
