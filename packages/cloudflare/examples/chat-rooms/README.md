# chat-rooms

Chat rooms on Cloudflare, on Effect Cluster: each room is one entity, `Room`, and so one Durable Object holding its messages in its own SQLite database. Members read, post and delete messages in the rooms they belong to over the Worker's JSON routes and MCP endpoint, which reach every room through `ActionEntity.reaching`. A page follows its room through an event, `MessagePosted`, over a WebSocket to the room's own object, which the runtime holds open while the room hibernates; an agent polls it over MCP, and a subscriber's callback receives it by webhook, delivered by the room across its eviction. A message expires a day after it was posted: posting schedules a persisted tell to the room itself, delivered by `DeliverAt`. A lobby, one more entity, keeps when each room was last active: each room tells it its latest activity and the version of its messages, from a persisted tell the room sends itself, carrying no credential, and a page follows it, every preview whole at each change.

Start here to run actions on Cloudflare. The same chat on a long-lived server is live-rpc, in the core package's `examples/`.

## Run it

From the repository root, after `vp install`:

```sh
vp test packages/cloudflare/examples/chat-rooms
```

The tests run inside the Workers runtime, on the Worker `wrangler.jsonc` describes, with `@cloudflare/vitest-plugin`. `browser.ts` is imported by a page, not run. The tokens are fixed names (`ada`, `grace`): replace them before deploying anything.

In a project that installs the package, copy this directory out of `node_modules/@gjermundgaraba/effect-actions-cloudflare/examples/`. It imports both packages by name and needs `effect` and `@effect/platform-cloudflare` beside them, `@cloudflare/workers-types` for its `tsconfig.json`, and `wrangler` to serve it (`wrangler dev`, `wrangler deploy` in its directory). Its tests need `vitest`, `@effect/vitest` and `@cloudflare/vitest-plugin`; `vite.config.ts` imports `defineConfig` from the repository's toolchain, `vite-plus`, which is Vitest's `vitest/config` elsewhere.

## When you copy this

Each trap below is shown in the code of the files it names.

- **One initializer builds the whole application, keeping the first runtime to finish for the isolate, and nothing slow builds after the cluster**: `quickOnceTheClusterIsBuilt` in `src/application.ts`, registered by `src/worker.ts`'s import.
- **The room is the entity's id**, and only a room `DemoRoomName` lists is reached: `src/chat/Chat.ts`, `src/entities.ts`, `roomOfAddress` in `src/routes.ts`.
- **Each room builds its stores over its own database, as it activates**: `services` in `src/routes.ts`.
- **The Worker serves every room, each room answers**: `src/routes.ts`.
- **A change sends its follow-ups before it writes**, its expiry and its tell to the lobby, so a crash after the write still runs them, and they read what it wrote only because they run after it, the room serving one call at a time and no handler answering through `Rpc.fork`: `followUpsRunAfterThisCall` in `src/chat/handlers.ts`, `concurrency: 1` in `src/routes.ts`.
- **A post schedules its expiry once per hour's window**: `src/chat/Tells.ts`, `src/chat/handlers.ts`, `src/platform/cluster-clients.ts`.
- **A failed task logs its cause and sends itself a retry later**, as Effect replays only a crash, until it succeeds, scheduling the retry fails or the room cannot be built when it is delivered, the last two leaving the task to a later change: `src/retry.ts`, `src/chat/handlers.ts`.
- **Each change asks the lobby in the room's one slot, for 2 seconds at most**, then leaves the change to the next change or a retry, each reading the room's latest again, so while the lobby takes no call, or answers late, as an ask queued behind other rooms' in the lobby's one slot does, a call reaching the room behind n asks waits up to 2n seconds; the lobby finishes a call the room stopped waiting for, and records and announces a change in one transaction: `src/chat/handlers.ts`, `src/lobby/Changes.ts`, `src/platform/sql-previews.ts`.
- **Changes may arrive in no set order, so the lobby keeps only a newer version**: `room_version` in `src/platform/sql-messages.ts`, `src/platform/sql-previews.ts`.
- **Every processed tell keeps its row**, which the runtime never prunes: one expiry a room an hour, one retry a minute at most while a task fails, and one lobby tell for each post or delete, refused or failed ones included, and for each run of an expiry, its retries included: `src/chat/Tells.ts`, `src/retry.ts`.
- **A page follows its room over its socket, and sends its token on each message**, as a page cannot set a browser socket's headers, while its actions stay on the JSON routes; a page built against other rpcs is refused, and stops: `src/browser.ts`, `src/worker.ts`, `src/Rpc.ts`.
- **The one migration creates the four classes**: `wrangler.jsonc`; a deployment of classes of its own adds a step deleting them, and their data.
- **A room's tells keep no credential**: `src/platform/cluster-clients.ts`, `test/worker.test.ts`.
- **The lobby's event is a whole value**, followed with no read first: `src/lobby/events.ts`, `src/browser.ts`.
- **Each room delivers its own webhook subscriptions**, kept in a table of its own and woken by a persisted tell for a wait of 10 seconds or more, and a subscribed room stays awake while its subscription lives, as `MessagePosted` is a check source asked again every 2 seconds: `src/platform/webhook-delivery.ts`, `Login` in `src/identity/Identity.ts`, `test/webhooks.test.ts`.

## Layout

```text
src/
├── chat/
│   ├── Chat.ts        contract: the rooms, the message, its errors, the room's actions and event
│   ├── Tells.ts       the room's own rpcs: its expiry, its tell to the lobby and their retry, and the expiry's window
│   ├── room.ts        Room, the room an entity holds: read from its address
│   ├── mailbox.ts     RoomMailbox, how a room tells itself
│   ├── store.ts       MessageStore, the service the handlers call
│   ├── events.ts      MessagePosted's check source, read from the store
│   ├── authorize.ts   the one authorization rule: a member of the entity's room
│   └── handlers.ts    Action.implement: contract to store, and the room's own rpcs' handlers
├── identity/
│   ├── Identity.ts    contract: CurrentMember and the Login descriptor
│   ├── members.ts     the demo members
│   └── verifier.ts    Authentication.layer: tokens to members, server only
├── lobby/
│   ├── Lobby.ts       contract: the previews action and event
│   ├── Changes.ts     the lobby's own rpc: a room's change, a volatile call
│   ├── client.ts      LobbyClient, how a room asks the lobby to record its change
│   ├── store.ts       PreviewStore, the previews the lobby keeps
│   ├── events.ts      PreviewsChanged's current source, the whole value
│   └── handlers.ts    the previews action, and the rpc recording a room's change
├── platform/
│   ├── object-sql.ts    the entity's own SQLite database, as SqlClient
│   ├── sql-messages.ts  MessageStore over the entity's SQLite database
│   ├── sql-previews.ts  PreviewStore over the lobby's
│   ├── webhook-delivery.ts  a room's webhook subscriptions, kept in its database, their long waits as wakes
│   └── cluster-clients.ts  RoomMailbox and LobbyClient over the entities' clients
├── Api.ts             the JSON bindings: a room's and the lobby's
├── Rpc.ts             the entities' bindings, and the version a page's socket names
├── entities.ts        Room and Lobby, the entities, each with its own rpcs
├── retry.ts           a failed task's later tries: logged, backed off to an hour
├── routes.ts          each entity's layer and services, and the Worker's routes
├── application.ts     the initializer: the whole application, once per isolate
├── worker.ts          entrypoint: the four classes, the room's sockets and the Worker's fetch
├── rooms-entrypoint.ts  the rooms' activity for another Worker
├── browser.ts         client module: a page's room over JSON and its socket, and the lobby
└── env.d.ts           the bindings' types, as `wrangler types` writes them
test/
├── worker.test.ts     through the Worker's fetch: JSON routes, a page's socket, MCP, the lobby, the expiry, the mailboxes
├── webhooks.test.ts   a room's posts by webhook: an eviction, an unsubscribe, a 410, refused callbacks, order, expiry
├── support.ts         the Worker's client and an object's tables, eviction and alarm
├── receiver.ts        the webhook callbacks, answered in Node as Miniflare's outbound service
└── worker.ts          the test Worker: the stub calls and instances each object counts
```

- **An entity is built per wake.** The runtime evicts an idle object and builds the entity again for its next message, its `services` and builders included: anything in memory is gone, and `layerSqlMessages` creates its table if it is not there. The database and the mailbox stay.
- **The room is an activation service, the caller is not.** An entity holds one room, so the authorizer yields `Room` once, as it is built. `CurrentMember` comes from authentication, per call.
- **The initializer chooses everything.** `application.ts` gives each entity its stores, the room its name and the lobby's mailbox, and the Worker its routes, all over `ActionCluster.layer`.

## Where to look

| To see | Read |
| --- | --- |
| The four classes, bindings and migration a cluster needs | `src/worker.ts`, `wrangler.jsonc` |
| One initializer building the application once per isolate | `src/application.ts` |
| An entity's stores over its own SQLite, built per activation | `src/routes.ts`, `src/platform/object-sql.ts`, `src/platform/sql-messages.ts` |
| An authorizer that yields the entity's room once, when it is built | `src/chat/authorize.ts`, `src/routes.ts` |
| A Worker serving every room's actions and event, each in the room it names | `src/routes.ts`, `test/worker.test.ts` |
| One MCP endpoint for every room, its event polled | `src/routes.ts`, `test/worker.test.ts` |
| A room refusing a call that names another room | `src/entities.ts`, `test/worker.test.ts` |
| A persisted tell scheduled by `DeliverAt`, one per `PrimaryKey`, handled per activation | `src/chat/Tells.ts`, `src/chat/handlers.ts`, `src/platform/cluster-clients.ts` |
| An entity calling another with a change, which notifies its own event in the same transaction | `src/chat/handlers.ts`, `src/lobby/handlers.ts`, `src/platform/sql-previews.ts` |
| An event sent as a whole value, followed with no read first | `src/lobby/events.ts`, `src/browser.ts`, `test/worker.test.ts` |
| A page's socket to its room, kept open while the room hibernates | `src/worker.ts`, `src/browser.ts`, `test/worker.test.ts` |
| Another Worker reaching the entities through the booted runtime | `src/rooms-entrypoint.ts` |
| A room's posts delivered by webhook, across its eviction | `src/platform/webhook-delivery.ts`, `src/routes.ts`, `test/webhooks.test.ts` |
| Testing on the Workers runtime: an eviction, a scheduled tell, a planted failure, the mailboxes | `test/worker.test.ts` |
