# chat-rooms

Chat rooms on Cloudflare: each room is one Durable Object, holding its messages in its own SQLite database and its pages' WebSockets while it hibernates. Members read, post and delete messages in the rooms they belong to over the room's socket, or the Worker's JSON routes and MCP endpoint, which reach every room. A page follows its room through an event, `MessagePosted`, its subscription kept while the object hibernates; an agent polls it over MCP. A message expires a day after it was posted, when the room's alarm runs. A lobby, one more object, keeps when each room was last active: each room tells it its latest activity over its stub, with Cloudflare's own RPC, and a page follows it, every preview whole at each change. The Worker in front serves the rooms' JSON routes and MCP endpoint itself, sending each call on to the room its input names, serves the previews, asking the lobby, and forwards a page's socket, `/rooms/<room>/rpc`, to the room's object and `/lobby/rpc` to the lobby's.

Start here to serve actions from Durable Objects. The same chat on a long-lived server is live-rpc, in the core package's `examples/`.

## Run it

From the repository root, after `vp install`:

```sh
vp test packages/cloudflare/examples/chat-rooms
```

The tests run inside the Workers runtime, on the Worker `wrangler.jsonc` describes, with `@cloudflare/vitest-plugin`. `browser.ts` is imported by a page, not run. The tokens are fixed names (`ada`, `grace`): replace them before deploying anything.

In a project that installs the package, copy this directory out of `node_modules/@gjermundgaraba/effect-actions-cloudflare/examples/`. It imports both packages by name and needs `effect` beside them, `@cloudflare/workers-types` for its `tsconfig.json`, and `wrangler` to serve it (`wrangler dev`, `wrangler deploy` in its directory). Its tests need `vitest`, `@effect/vitest` and `@cloudflare/vitest-plugin`; `vite.config.ts` imports `defineConfig` from the repository's toolchain, `vite-plus`, which is Vitest's `vitest/config` elsewhere.

## When you copy this

Each trap below is shown in the code of the files it names.

- **A page sends its token on each message**, as a browser WebSocket sets no header on its upgrade: `src/browser.ts`; `test/worker.test.ts` connects both ways.
- **The room is the object's name**, and only a room `DemoRoomName` lists is reached: `src/chat/Chat.ts`, `src/worker.ts`.
- **The Worker serves every room, each room answers**, through the placement `rooms`: `src/routes.ts`.
- **A page reads, then watches from the last message it holds**: `src/browser.ts`, `src/chat/events.ts`.
- **`postMessage` notifies `MessagePosted`**: `src/chat/handlers.ts`, `src/chat/events.ts`.
- **Objects call each other over their stubs, not their `fetch`**: `src/lobby/Calls.ts`, `src/platform/lobby-stubs.ts`.
- **A room tells the lobby its latest activity, and the lobby notifies**: `tellLobby` in `src/platform/lobby-stubs.ts`, `src/lobby/handlers.ts`.
- **The lobby's event is a whole value**, followed with no read first: `src/lobby/events.ts`, `src/browser.ts`.

## Layout

```text
src/
├── chat/
│   ├── Chat.ts        contract: the rooms, the message, its errors, the room's actions
│   ├── room.ts        Room, the room an instance holds: a startup service
│   ├── activity.ts    Activity, where a room says it changed: the lobby
│   ├── store.ts       MessageStore, the service the handlers call
│   ├── events.ts      MessagePosted's check source, read from the store
│   ├── authorize.ts   the one authorization rule: a member of the instance's room
│   └── handlers.ts    Action.implement: contract to store
├── identity/
│   ├── Identity.ts    contract: CurrentMember and the Login descriptor
│   ├── members.ts     the demo members
│   └── verifier.ts    Authentication.layer: tokens to members, server only
├── lobby/
│   ├── Lobby.ts       contract: the previews, the Worker's action and the lobby's event
│   ├── Calls.ts       the lobby's own API over its stub, for the rooms and the Worker
│   ├── store.ts       PreviewStore, the previews the lobby keeps
│   ├── events.ts      PreviewsChanged's current source, the whole value
│   ├── host.ts        LobbyHost, the lobby's object as the Worker reaches it
│   └── handlers.ts    the Worker's action, and the lobby's calls recording a room's activity
├── platform/
│   ├── sql-store.ts   MessageStore over the object's SQLite database, and its alarm
│   ├── kv-previews.ts PreviewStore over the lobby's synchronous key-value storage
│   └── lobby-stubs.ts LobbyHost, Activity and the room's task over the lobby's stub
├── Api.ts             the JSON bindings: a room's and the lobby's
├── Rpc.ts             the RPC bindings: a room's actions and event, and the lobby's event
├── routes.ts          each object's routes, the lobby's calls over its stub, the Worker's routes
├── worker.ts          entrypoint: the room's and the lobby's classes and the Worker's fetch
├── rooms-entrypoint.ts  the rooms' activity for another Worker, a program per call
├── browser.ts         client module: a page's socket, its room and the lobby
└── env.d.ts           the bindings' types, as `wrangler types` writes them
test/
├── platform/          the store against a real object's database
├── support/           a page's socket, upgraded through the Worker
└── worker.test.ts     through the Worker's fetch: sockets, JSON routes, MCP, the lobby, the alarm
```

- **An instance is built per wake.** The runtime evicts an idle object and constructs a new instance for its next event, which builds its services and routes again: anything in memory is gone, and `layerSql` creates its table if it is not there. The database and the sockets stay.
- **The room is a startup service, the caller is not.** An instance holds one room, so the authorizer yields `Room` once, when it is built, as a builder yields a store. `CurrentMember` comes from authentication, per message.
- **The entrypoint chooses everything.** `worker.ts` gives a room's object the SQLite store, the room, its name, and the lobby's stub as its services, which an instance builds once for the routes, the task and the alarm; it gives the lobby's object its store, and the Worker's handler the lobby's stub.
- **The Worker forwards a socket, the object answers.** Forwarding a request forwards its upgrade, so the Worker passes a page's socket request to the room's object unchanged but its path; every other call it serves itself, through the placement.

## Where to look

| To see | Read |
| --- | --- |
| A Durable Object class serving actions, and its alarm | `src/worker.ts` |
| Rpcs on hibernating WebSockets beside JSON routes, in one object | `src/routes.ts` |
| An authorizer that yields the instance's room once, when it is built | `src/chat/authorize.ts`, `src/chat/handlers.ts` |
| A store over the object's SQLite database, setting its alarm with `Alarm` | `src/platform/sql-store.ts` |
| A startup service read from the object's state, its name | `src/worker.ts` |
| A Worker calling an object's own API over its stub, with Cloudflare's RPC | `src/lobby/Calls.ts`, `src/routes.ts`, `src/platform/lobby-stubs.ts` |
| An object telling another of a change, which notifies its own event | `src/platform/lobby-stubs.ts`, `src/lobby/handlers.ts` |
| An event sent as a whole value, followed with no read first | `src/lobby/events.ts`, `src/browser.ts`, `test/worker.test.ts` |
| Routing requests and upgrades from the Worker to an object | `src/worker.ts` |
| A page's socket client, its token on each message | `src/browser.ts` |
| An event a page watches on its socket, kept while the object hibernates | `src/chat/events.ts`, `src/browser.ts`, `test/worker.test.ts` |
| A Worker serving every room's actions and event, each in the room it names | `src/routes.ts`, `src/worker.ts`, `test/worker.test.ts` |
| One MCP endpoint for every room, its event polled | `src/routes.ts`, `test/worker.test.ts` |
| A room refusing a call that names another room | `src/chat/Chat.ts`, `src/worker.ts`, `test/worker.test.ts` |
| Refusing a page of another version with a close code it reads | `src/routes.ts`, `src/browser.ts` |
| Testing on the Workers runtime: an eviction, the alarm, the database | `test/worker.test.ts`, `test/platform/` |
| A socket that keeps the token of its upgrade request | `test/worker.test.ts` |
