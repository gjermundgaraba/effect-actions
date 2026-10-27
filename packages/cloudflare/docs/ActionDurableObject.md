# ActionDurableObject

Actions served from a Cloudflare Durable Object. A **Durable Object** is a class a Worker's Wrangler configuration binds, with one **object** per id or name, running in one place at a time with its own storage. The runtime constructs an **instance** of the class for an object's first event, **evicts** it when idle, and constructs another for the next. An object serves the routes the core serves elsewhere, Effect RPC on WebSockets the runtime holds open while the object **hibernates**, evicted with its sockets kept, rpcs over its stub, and an alarm. Reach for it when state belongs to one thing, such as a room, a document or a tenant, and its callers should meet in one place.

Import `@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject`. A message the library throws says its fix; for workerd's, a compiler diagnostic or Effect's own error, search [ActionDurableObject-failures.md](ActionDurableObject-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions-cloudflare/dist/`: each declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot show. Events are on [ActionDurableObject-events.md](ActionDurableObject-events.md), calls over the stub on [ActionDurableObject-stub.md](ActionDurableObject-stub.md), tests and runtimes on [ActionDurableObject-testing.md](ActionDurableObject-testing.md), and a class that cannot extend `make`'s on [ActionDurableObject-own-class.md](ActionDurableObject-own-class.md).

## Serve actions from an object

Give `make` the routes, as the core's surfaces build them, and their startup services, and export the class it returns, or one extending it, under the name the Wrangler configuration binds. The entrypoint holds the room's class beside the Worker's own `fetch`:

```ts example=chat-rooms/src/worker.ts
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { Activity } from "./chat/activity.js";
import { RoomName } from "./chat/Chat.js";
import { Room } from "./chat/room.js";
import { MessageStore } from "./chat/store.js";
import { layerKvPreviews } from "./platform/kv-previews.js";
import {
  layerActivity,
  layerLobbyHost,
  tellLobby,
} from "./platform/lobby-stubs.js";
import { layerSql } from "./platform/sql-store.js";
import {
  lobbyCalls,
  lobbyRoutes,
  roomRoutes,
  rooms,
  workerRoutes,
} from "./routes.js";

// The rooms for another Worker, over a service binding: a named entrypoint of this one.
export { RoomsEntrypoint } from "./rooms-entrypoint.js";

// Entrypoint, Wrangler's `main`: the composition root of the Worker and of every object. It
// chooses the stores, the room and the stubs, and routes each request.

const decodeRoom = Schema.decodeUnknownEffect(RoomName);

// A room's Durable Object, bound as CHAT_ROOM in wrangler.jsonc under this export's name. Each
// instance builds its services, the store, the room and its activity, then its routes, as it is
// constructed, again after every eviction. The room is the name the Worker reached the object by,
// `getByName(room)`, decoded once there: `ActionDurableObject.name` dies for an object reached by
// an id, and the build fails for a name `RoomName` does not list, each a bug in the Worker. Given
// `rooms`, it refuses a call or a watch whose input names another room. Its `lobby` task tells
// the lobby of each change, on the alarm until the lobby hears. The alarm expires old messages
// and tells the lobby, as an expired message can be the room's latest.
export class ChatRoom extends ActionDurableObject.make({
  placed: rooms,
  services: () =>
    Layer.mergeAll(layerSql, layerActivity).pipe(
      Layer.provideMerge(
        Layer.effect(Room)(Effect.flatMap(ActionDurableObject.name, decodeRoom))
      )
    ),
  routes: roomRoutes,
  tasks: { lobby: tellLobby },
  alarm: () =>
    Activity.use((activity) =>
      activity.changing(MessageStore.use((store) => store.expire))
    ),
}) {}

// The lobby's Durable Object, bound as CHAT_LOBBY: one for the Worker, named `lobby`, keeping
// every room's preview, which each room tells it of and its pages follow.
export class ChatLobby extends ActionDurableObject.make({
  services: () => layerKvPreviews,
  routes: lobbyRoutes,
  calls: lobbyCalls,
}) {}

// The Worker's own handler, built once, when the module loads, which keeps the lobby's client
// from stranding as `ActionDurableObject.layerStubClient`'s gotchas say: building it does no I/O,
// which a Worker refuses outside a request. `toWebHandler` reads no `MaxBodySize`, so the
// platform limits request bodies.
const served = HttpRouter.toWebHandler(
  workerRoutes.pipe(
    Layer.provide(layerLobbyHost),
    Layer.provide(HttpServer.layerServices)
  )
);

const isRoomName = Schema.is(RoomName);

// A page's socket, `/rooms/<room>/rpc` or `/lobby/rpc`, is its object's `/rpc`: forwarding the
// request forwards its upgrade, and the object answers it. Everything else is the Worker's own,
// the rooms' calls among them, which it sends on to each room's object itself.
export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    const url = new URL(request.url);

    const room =
      /^\/rooms\/(?<room>[^/]+)\/rpc$/u.exec(url.pathname)?.groups?.room ?? "";

    if (url.pathname === "/lobby/rpc" || isRoomName(room)) {
      url.pathname = "/rpc";

      const object = isRoomName(room)
        ? env.CHAT_ROOM.getByName(room)
        : env.CHAT_LOBBY.getByName("lobby");

      return await object.fetch(new Request(url, request));
    }

    return await served.handler(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
```

[chat-rooms/wrangler.jsonc](../examples/chat-rooms/wrangler.jsonc) binds each class with a SQLite migration. The rules of each option, when it builds and what it may require, are on `ActionDurableObject.Options`; what an instance builds, and when again, on `ActionDurableObject.handlers`; the class itself on `ActionDurableObject.make`, whose `services` is a function of the instance's `env`, `() => layer` for services reading none.

- A service read from the object is a Layer requiring `State`: a store over its SQLite database ([chat-rooms/src/platform/sql-store.ts](../examples/chat-rooms/src/platform/sql-store.ts)), or what the object is, such as its name, `ActionDurableObject.name`, the room in `worker.ts` above.
- An authorizer that depends on the object, such as on its room, yields that startup service once, when it is built ([chat-rooms/src/chat/authorize.ts](../examples/chat-rooms/src/chat/authorize.ts)).
- A class extending the one `make` returns overrides only the handlers it has reason to write, and reaches `make`'s with `super`; a socket it accepts itself is its own to answer.

## Serve rpcs over hibernating WebSockets

Give `ActionRpc.layer` the protocol `layerWebSocket` makes, at a path of the object's, beside the JSON routes in one routes Layer:

```ts example=chat-rooms/src/routes.ts
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { env } from "cloudflare:workers";
import { Layer } from "effect";
import { RpcServer } from "effect/rpc";

import { LobbyHttp, RoomHttp } from "./Api.js";
import { messageEvents } from "./chat/events.js";
import { messages } from "./chat/handlers.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { LobbyCalls } from "./lobby/Calls.js";
import { previewEvents } from "./lobby/events.js";
import { calls as lobbyHandlers, lobby } from "./lobby/handlers.js";
import {
  LobbyRpc,
  protocolVersion,
  RoomRpc,
  unsupportedProtocol,
} from "./Rpc.js";

const room = [messages, messageEvents];

const byRoom = (input: { readonly room: string }) => input.room;

// Where each room's calls and watches are served: in the room's object, the one each contract's
// key names. worker.ts gives it to the room's class, which then refuses an input naming another
// room, on its socket too; the Worker serves it below.
export const rooms = ActionDurableObject.placed(RoomHttp, {
  readMessages: byRoom,
  postMessage: byRoom,
  deleteMessage: byRoom,
  "message.posted": byRoom,
});

// One socket route for each object's pages, refusing a page of another version.
const pageSocket = ActionDurableObject.layerWebSocket({
  path: "/rpc",
  protocol: { version: protocolVersion, code: unsupportedProtocol },
});

// What a room's object serves. Its rpcs on WebSockets the runtime holds while the object
// hibernates: a socket keeps the token its upgrade request carried, and each message is
// authenticated with it, or with the message's own. The socket's route refuses a page naming
// another version in its URL, `?protocol=<n>` as browser.ts sends it, with a close code the page's
// client reads as `SocketCloseError` and stops connecting again at, not a 403, which a browser
// reports as a bare 1006 its page connects again after. Its JSON routes, where the Worker sends
// each call and watch on, the token with it: the object authenticates it again, and authorizes.
// It requires `MessageStore`, `Room` and `Activity` at startup: worker.ts chooses them.
export const roomRoutes = Layer.mergeAll(
  ActionRpc.layer(RoomRpc, room).pipe(Layer.provide(pageSocket)),
  ActionHttp.layer(RoomHttp, room)
).pipe(Layer.provide(authenticate));

// What the lobby's object serves: `PreviewsChanged` on its pages' sockets, a socket a page
// signed out opens too, as nothing on it is protected. It requires `PreviewStore` at startup.
export const lobbyRoutes = ActionRpc.layer(LobbyRpc, [previewEvents]).pipe(
  Layer.provide(pageSocket)
);

// What the lobby's object serves over its stub: its own calls, on Effect's own RpcServer, for
// the rooms and the Worker, which call them with Cloudflare's own RPC. It requires `PreviewStore`
// at startup.
export const lobbyCalls = RpcServer.layer(LobbyCalls).pipe(
  Layer.provide(lobbyHandlers)
);

// The rooms as the Worker serves them, each call sent on to its room's object. The room is read
// from `env` as each call is sent.
const inRooms = ActionDurableObject.reaching(rooms, () => env.CHAT_ROOM);

// What the Worker serves: the rooms' JSON routes and `previews`, which it asks the lobby's object
// for, at `/api`, and all of them at `/mcp`, the actions as tools and `MessagePosted` as an MCP
// event, so one agent's connection reaches every room. Nothing in a Worker outlives a request, so
// the endpoint is request scoped: MCP 2026-07-28 alone, and events by `events/poll`, a poll every
// 30 seconds as events.ts asks. The Worker authenticates each call, and the room's object again.
// It requires `LobbyHost`.
export const workerRoutes = Layer.mergeAll(
  ActionHttp.layer(LobbyHttp, lobby),
  ActionHttp.layer(RoomHttp, inRooms),
  ActionMcp.layerHttp([lobby, ...inRooms], {
    name: "chat-rooms",
    version: "1.0.0",
    authentication: Login,
    requestScoped: true,
  })
).pipe(Layer.provide(authenticate));
```

What a socket keeps across hibernation, how each message authenticates, and what the runtime answers itself are on `ActionDurableObject.layerWebSocket`. Its `protocol` option refuses a page naming another version of the rpcs in its URL with a close code the page's client reads, as a browser cannot read a refused upgrade's status; the page's client stops connecting at that code given the core's `ActionRpc.reconnectUntil` as its `retryPolicy`. Router middleware provided to it runs for the upgrade alone, and refuses one by any other judge, such as a foreign `Origin`, with `ActionDurableObject.refuseUpgrade`. A page's client speaks JSON over `RpcClient.layerProtocolSocket` and `Socket.layerWebSocket(url)`, its token on each message ([chat-rooms/src/browser.ts](../examples/chat-rooms/src/browser.ts)), and the Worker forwards a page's upgrade to the room's object by forwarding its `Request`, as `worker.ts` does above.

## Follow an event

List an event's implementation beside the actions in `ActionRpc.layer`, as `routes.ts` above does, and a page watches it on its socket, an agent over MCP or by webhook: [ActionDurableObject-events.md](ActionDurableObject-events.md).

## Serve the objects' actions from the Worker

Give each of a binding's contracts a key of its input, `rooms` in `routes.ts` above, and the Worker serves them on any surface, each call sent on to the object the key names, which refuses one naming another: [ActionDurableObject-placement.md](ActionDurableObject-placement.md).

## Run an alarm

Give `make` an `alarm`, and set when it runs from a handler or a store with the `Alarm` service, which keeps the earliest time it is given: the room's store sets it for each message's expiry as it is posted and, each run, for the oldest left ([chat-rooms/src/platform/sql-store.ts](../examples/chat-rooms/src/platform/sql-store.ts)), and `worker.ts` above gives the alarm the store the routes read. How it runs, and how a failure is retried, are on `ActionDurableObject.Options`' `alarm`; how to postpone it, and why `State`'s `storage.setAlarm` is not the way, on `ActionDurableObject.Alarm`.

## Call an object from a Worker

Call its `calls` with `client`, the declared errors typed, and its routes with the core's clients over `layerHttpClient(stub)`: [ActionDurableObject-stub.md](ActionDurableObject-stub.md).

## Test and deploy

Test an object on the Workers runtime, and what differs between runtimes: [ActionDurableObject-testing.md](ActionDurableObject-testing.md).
