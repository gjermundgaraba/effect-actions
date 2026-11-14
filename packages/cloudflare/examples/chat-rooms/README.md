# chat-rooms

Chat rooms on Cloudflare, on Effect Cluster: each room is one entity, `Room`, and so one Durable Object holding its messages in its own SQLite database. Members read and post messages in the rooms they belong to over the Worker's JSON routes and MCP endpoint, which reach every room through `ActionEntity.reaching`. A page follows its room through an event, `MessagePosted`, over a WebSocket to the room's own object, which the runtime holds open while the room hibernates; an agent polls it over MCP, and a subscriber's callback receives it by webhook, delivered by the room across its eviction.

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
- **The Worker serves every room, and each room builds its stores over its own database as it activates**: `services` in `src/routes.ts`.
- **A post writes its message and wakes its followers in one transaction, and the table keeps one message per author and `request`**, so a post whose notification fails keeps nothing, and a page sending it again with its `request`, even after the room failed past its write, is answered with the first message, notifying nothing; the page sends it again only after a transport failure: `src/platform/sql-messages.ts`, `src/chat/handlers.ts`, `src/browser.ts`.
- **A page follows its room over its socket, and sends its token on each message**, as a page cannot set a browser socket's headers, while its actions stay on the JSON routes; a page built against other rpcs is refused, and stops: `src/browser.ts`, `src/worker.ts`, `src/Rpc.ts`.
- **A page watches over its socket, which lets the room hibernate**; a stream through the Worker, its JSON `watch` or MCP's `events/stream`, calls the room each `nextPoll`, 2 seconds, while it is open, so the room never hibernates: `followRoom` in `src/browser.ts`, `nextPoll` in `src/chat/events.ts`.
- **The one migration creates the four classes**: `wrangler.jsonc`; a deployment of classes of its own adds a step deleting them, and their data.
- **Each room delivers its own webhook subscriptions**, kept in a table of its own and woken by a persisted tell for a wait of 10 seconds or more, and a subscribed room hibernates while idle, as `MessagePosted` is `notified`, asked again only when a post notifies it: `roomWebhooks` in `src/routes.ts`, `src/platform/webhook-delivery.ts`, `Login` in `src/identity/Identity.ts`, `test/webhooks.test.ts`.

## Layout

```text
src/
├── chat/
│   ├── Chat.ts        contract: the rooms, the message, the room's actions and event
│   ├── room.ts        Room, the room an entity holds: read from its address
│   ├── store.ts       MessageStore, the service the handlers call
│   ├── events.ts      MessagePosted's check source, read from the store
│   ├── authorize.ts   the one authorization rule: a member of the entity's room
│   └── handlers.ts    Action.implement: contract to store
├── identity/
│   ├── Identity.ts    contract: CurrentMember and the Login descriptor
│   ├── members.ts     the demo members
│   └── verifier.ts    Authentication.layer: tokens to members, server only
├── platform/
│   ├── object-sql.ts    the entity's own SQLite database, as SqlClient
│   ├── sql-messages.ts  MessageStore over the entity's SQLite database
│   └── webhook-delivery.ts  the table a room keeps its webhook subscriptions in, and fetch's client for their POSTs
├── Api.ts             the room's JSON binding
├── Rpc.ts             the room's rpc binding, and the version a page's socket names
├── entities.ts        Room, the entity
├── routes.ts          the entity's layer and services, and the Worker's routes
├── application.ts     the initializer: the whole application, once per isolate
├── worker.ts          entrypoint: the four classes, the room's sockets and the Worker's fetch
├── browser.ts         client module: a page's room over JSON and its socket
└── env.d.ts           the bindings' types, as `wrangler types` writes them
test/
├── worker.test.ts     through the Worker's fetch: JSON routes, a page's socket, MCP, the stub calls a post costs
├── webhooks.test.ts   a room's posts by webhook: an eviction, an unsubscribe, a 410, refused callbacks, order, hibernation, expiry
├── support.ts         the Worker's client and an object's tables, eviction and alarm
├── receiver.ts        the webhook callbacks, answered in Node as Miniflare's outbound service
└── worker.ts          the test Worker: the stub calls and instances each object counts, and a failure planted after a call
```

- **An entity is built per wake.** The runtime evicts an idle object and builds the entity again for its next message, its `services` and builders included: anything in memory is gone, and `layerSqlMessages` creates its table if it is not there. The database stays.
- **The room is an activation service, the caller is not.** An entity holds one room, so the authorizer yields `Room` once, as it is built. `CurrentMember` comes from authentication, per call.
- **The initializer chooses everything.** `application.ts` gives the room its stores and its name, and the Worker its routes, all over `ActionCluster.layer`.

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
| A page's socket to its room, kept open while the room hibernates | `src/worker.ts`, `src/browser.ts`, `test/worker.test.ts` |
| A room's posts delivered by webhook, across its hibernation | `src/routes.ts`, `src/platform/webhook-delivery.ts`, `test/webhooks.test.ts` |
| A post that writes and notifies in one transaction, posted once per request when sent again | `src/platform/sql-messages.ts`, `test/worker.test.ts` |
| Testing on the Workers runtime: an eviction, a planted failure, the stub calls a post costs | `test/worker.test.ts` |
