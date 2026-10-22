# chat-rooms

Chat rooms on Cloudflare: each room is one Durable Object, holding its messages in its own
SQLite database and its pages' WebSockets while it hibernates. Members follow, post and delete
messages in the rooms they belong to over the socket, and post or delete them over the room's
JSON routes. A message expires a day after it was posted, when the room's alarm runs. The Worker in front
routes `/rooms/<room>/…` to the room's object and serves a lobby itself, which asks each room
when it was last active over the room's stub, with Cloudflare's own RPC.

Start here to serve actions from Durable Objects. The same chat on a long-lived server is
live-rpc, in the core package's `examples/`.

## Run it

From the repository root, after `vp install`:

```sh
vp test packages/cloudflare/examples/chat-rooms
```

The tests run inside the Workers runtime, on the Worker `wrangler.jsonc` describes, with
`@cloudflare/vitest-plugin`. `browser.ts` is imported by a page, not run. The tokens are fixed
names (`ada`, `grace`): replace them before deploying anything.

In a project that installs the package, copy this directory out of
`node_modules/@gjermundgaraba/effect-actions-cloudflare/examples/`. It imports both packages by
name and needs `effect` beside them, `@cloudflare/workers-types` for its `tsconfig.json`, and
`wrangler` to serve it (`wrangler dev`, `wrangler deploy` in its directory). Its tests need
`vitest`, `@effect/vitest` and `@cloudflare/vitest-plugin`; `vite.config.ts` imports
`defineConfig` from the repository's toolchain, `vite-plus`, which is Vitest's `vitest/config`
elsewhere.

## When you copy this

- **A page sends its token on each message**, because a browser WebSocket sets no header on its
  upgrade. A client that can, such as a Worker or a native app, sends it once on the upgrade,
  and its socket keeps it across hibernations: `test/worker.test.ts` connects both ways.
- **The room is the object's name**, `getByName(room)`, and the Worker reaches only the rooms
  `RoomName` lists: any other name is refused before it reaches `getByName`, so no caller
  creates an object. Yours may keep its rooms in a store.
- **`preview` is public** so a page can show anyone signed out when the room was last active.
  What was said stays with the room's members.
- **A page follows the room**, through `watch`, an rpc that streams, beside the room's actions
  on its binding: a message posted reaches every page following the room, after the object
  hibernated too, and a page whose socket dropped subscribes again from the last message it
  holds.
- **The lobby calls a room over its stub, not its `fetch`**: the room serves its own API, a
  plain Effect `RpcGroup` no page calls, as its `calls`, and the lobby calls it with
  `ActionDurableObject.client`, a new stub for each call. Nothing authenticates a stub call,
  which only the Worker's binding reaches. To call the room's actions over its stub instead,
  serve `ActionRpc.layer` as its `calls` and call them with `ActionRpc.client` over
  `layerStubClient`, forwarding a member's token in each call's headers.

## Layout

```text
src/
├── chat/
│   ├── Chat.ts        contract: the rooms, the message, its errors, the room's actions, its feed
│   ├── Calls.ts       the room's own API over its stub, a plain RpcGroup for the Worker
│   ├── room.ts        Room, the room an instance holds: a startup service
│   ├── store.ts       MessageStore, the service the handlers call
│   ├── authorize.ts   the one authorization rule: a member of the instance's room
│   └── handlers.ts    Action.implement: contract to store, the feed's and the calls' handlers
├── identity/
│   ├── Identity.ts    contract: CurrentMember and the Login descriptor
│   ├── members.ts     the demo members
│   └── verifier.ts    Authentication.layer: tokens to members, server only
├── lobby/
│   ├── Lobby.ts       contract: the Worker's own action
│   ├── rooms.ts       Rooms, the rooms as the Worker reaches them
│   └── handlers.ts    Action.implement: every room asked at once
├── platform/
│   ├── sql-store.ts   MessageStore over the object's SQLite database, and its alarm
│   └── room-stubs.ts  Rooms over each room's stub, with ActionDurableObject.client
├── Api.ts             the JSON bindings: a room's and the lobby's
├── Rpc.ts             the room's RPC binding: its actions and its feed
├── routes.ts          a room's routes, its calls over its stub and the lobby's routes
├── worker.ts          entrypoint: the room's Durable Object class and the Worker's fetch
├── rooms-entrypoint.ts  the rooms for another Worker, a WorkerEntrypoint running a program per call
├── browser.ts         client module: a page's socket and its room
└── env.d.ts           the bindings' types, as `wrangler types` writes them
test/
├── platform/          the store against a real object's database
├── support/           a page's socket, upgraded through the Worker
└── worker.test.ts     through the Worker's fetch: sockets, JSON routes, the lobby, the alarm
```

- **An instance is built per wake.** The runtime evicts an idle object and constructs a new
  instance for its next event, which builds its services and routes again: anything in memory
  is gone, and `layerSql` creates its table if it is not there. The database and the sockets
  stay.
- **The room is a startup service, the caller is not.** An instance holds one room, so the
  authorizer yields `Room` once, when it is built, as a builder yields a store. `CurrentMember`
  comes from authentication, per message.
- **The entrypoint chooses everything.** `worker.ts` gives the object the SQLite store and the
  room, its name, as its services, which an instance builds once for the routes, the calls and the alarm,
  and gives the lobby the stubs.
- **The Worker forwards, the object answers.** Forwarding a request forwards its upgrade, so
  the Worker passes a page's socket request to the room's object unchanged but its path.

## Where to look

| To see                                                                    | Read                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A Durable Object class serving actions, and its alarm                     | `src/worker.ts`                                                    |
| Rpcs on hibernating WebSockets beside JSON routes, in one object          | `src/routes.ts`                                                    |
| An authorizer that yields the instance's room once, when it is built      | `src/chat/authorize.ts`, `src/chat/handlers.ts`                    |
| A store over the object's SQLite database, setting its alarm              | `src/platform/sql-store.ts`                                        |
| A startup service read from the object's state, its name                  | `src/worker.ts`                                                    |
| A Worker calling an object's own API over its stub, with Cloudflare's RPC | `src/chat/Calls.ts`, `src/routes.ts`, `src/platform/room-stubs.ts` |
| Routing requests and upgrades from the Worker to an object                | `src/worker.ts`                                                    |
| A page's socket client, its token on each message                         | `src/browser.ts`                                                   |
| Refusing a page of another version with a close code it reads             | `src/routes.ts`, `src/browser.ts`                                  |
| Pushing each message to the pages following a room, across hibernation    | `src/chat/handlers.ts`, `src/browser.ts`                           |
| Testing on the Workers runtime: an eviction, the alarm, the database      | `test/worker.test.ts`, `test/platform/`                            |
| A socket that keeps the token of its upgrade request                      | `test/worker.test.ts`                                              |
