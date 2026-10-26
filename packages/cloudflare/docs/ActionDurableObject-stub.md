# ActionDurableObject over the stub

A **stub** is what a Worker, or another object, reaches an object through,
`env.<BINDING>.getByName(name)`, and a **stub call** a call of one of the object's methods over
it, with Cloudflare's own RPC, Workers RPC. An object serves rpcs on one such method,
`effectActionsRpc`, named for the package so it does not collide with the class's own, and a
caller calls them with a typed client whose errors are the declared ones. Read
[ActionDurableObject.md](ActionDurableObject.md) first. A message the library throws says its
fix; for workerd's, a compiler diagnostic or Effect's own error, search
[ActionDurableObject-failures.md](ActionDurableObject-failures.md).

## Serve an object's own API over its stub

Declare what only the Worker and other objects call as a plain Effect `RpcGroup`:

```ts example=chat-rooms/src/chat/Calls.ts
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

// A room's own API, which only the Worker calls, over the room's stub with Cloudflare's own
// RPC. A plain Effect `RpcGroup`, not actions: no page calls it, so it needs no contract
// checks, no authentication and no JSON route, and nothing authenticates a stub call anyway,
// as only a binding reaches it. The room's object and the Worker both import it.
export const RoomCalls = RpcGroup.make(
  Rpc.make("latestAt", { success: Schema.NullOr(Schema.Int) }),
);
```

Its handlers read the store the instance built
([chat-rooms/src/chat/handlers.ts](../examples/chat-rooms/src/chat/handlers.ts)), and
`RpcServer.layer(RoomCalls)` over them is the object's `calls`, beside its routes
([chat-rooms/src/routes.ts](../examples/chat-rooms/src/routes.ts)), given to `make` in
[chat-rooms/src/worker.ts](../examples/chat-rooms/src/worker.ts). `make` gives the calls their
protocol; what crosses it, as values and not JSON, what it refuses and what the calls may require
are on `ActionDurableObject.Options`' `calls`.

A plain group suits an object's own API, which no page calls. Actions served on other surfaces
too are served the same way, `calls: ActionRpc.layer(RoomRpc, room)`, and called with
`ActionRpc.client(RoomRpc)` over `layerStubClient(env.CHAT_ROOM.getByName(room))`: their
values cross as JSON, and a protected action authenticates each call from its headers, so the
caller forwards the user's credential with `RpcClient.withHeaders`.

## Call it from the Worker

`client(group)` makes one client, in the caller's `Scope`, for every object of a class, and
returns `(stubOf) => client`: each call gets a new stub from `stubOf`, as it is sent, and fails
with the rpc's declared errors or the stub's own, an `RpcClientError`, which the caller retries
or makes a defect.

```ts example=chat-rooms/src/platform/room-stubs.ts
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { RoomCalls } from "../chat/Calls.js";
import { Rooms } from "../lobby/rooms.js";

// The rooms through their objects' stubs: each call is one of the room's own calls, sent with
// Cloudflare's own RPC, never its `fetch`. One client serves every room, and each call gets a
// new stub from the function it is given, as it is sent: an exception can leave a stub broken,
// failing every later call through it, so none is held. The function reads `env` as the call
// is sent, never as the module loads. A room that cannot be reached, the client's
// `RpcClientError`, is the deployment's failure, not the caller's: made a defect here, the lobby
// answers 500, and the cause is in the Worker's logs.
export const layerRooms = Layer.effect(Rooms)(
  Effect.map(ActionDurableObject.client(RoomCalls), (room) =>
    Rooms.of({
      latestAt: (name) => Effect.orDie(room(() => env.CHAT_ROOM.getByName(name)).latestAt()),
    }),
  ),
);
```

Why no stub is held, when one breaks and when a call may be repeated are on
`ActionDurableObject.client`. From another object, make the client where it calls, as a room's
task below does. `RpcClient.make` requires a `Scope` natively, so no client
without one is offered.

In a Worker, run each call as its own program given the client's Layer, as chat-rooms'
`RoomsEntrypoint` below does: the client is built and closed in the request that uses it. A
client kept across requests needs care. It forks its receive fiber on a timer of the request
that builds it, and workerd drops a request's timers when it ends: a client first built inside a
request that ends without waiting on I/O, succeeding or refused, never starts that fiber, and
every later call through it waits until workerd cancels it as hung. `HttpRouter.toWebHandler`
builds its Layer as it is called, so one called as the module loads, as chat-rooms'
[worker.ts](../examples/chat-rooms/src/worker.ts) builds its own handler, escapes it, and one called
lazily inside a request does not; `ManagedRuntime.make(layer)` builds nothing until its first
run, so one made at module scope is still built inside a request. For a runtime or handler
deliberately shared across requests, follow Effect's own recipe in `HttpRouter.toWebHandler`'s
gotchas: build it at module scope, and provide `new Scheduler.MixedScheduler("sync")` to the
whole application Layer with `Layer.provideMerge`, for its build and its requests;
`Scheduler.MixedScheduler`'s gotchas say what that does not fix. This forbids neither a
`ManagedRuntime` nor a cached handler: pure services in a cached runtime stay usable, and only the fibers its build forks, such as a client's receive fiber, are stranded. In a Durable Object, `make` and `handlers` run every Effect
under that scheduler, as `handlers` says, so a client an object builds starts its receive fiber
on a microtask, never a request's timer.

A Worker's entrypoint that is no Effect program, such as a `WorkerEntrypoint` method or a queue
consumer, runs each call as its own program. chat-rooms' `RoomsEntrypoint`, which `worker.ts`
exports, serves the rooms to another Worker:

```ts example=chat-rooms/src/rooms-entrypoint.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { RoomName } from "./chat/Chat.js";
import { Rooms } from "./lobby/rooms.js";
import { layerRooms } from "./platform/room-stubs.js";

const decodeRoom = Schema.decodeUnknownEffect(RoomName);

// The rooms for another Worker, over a service binding to this one's `RoomsEntrypoint`, which
// worker.ts exports. A method of a `WorkerEntrypoint` is no Effect program, so each call runs as
// one, given the rooms' Layer: the client is built in the request that uses it, and closed with
// it, which costs no I/O. A client kept across requests instead, in a `ManagedRuntime` made at
// module scope, would be built at its first run, inside a request: one that ends without waiting
// on I/O, succeeding or refused, never starts the client's receive fiber, and every later call
// through it waits for good. The stub page says how to share one safely.
export class RoomsEntrypoint extends WorkerEntrypoint<Cloudflare.Env> {
  // The calling Worker is another deployment, so its room is checked as any input is: an unknown
  // room rejects the call with the schema's error, as a room that cannot be reached rejects it
  // with the defect room-stubs.ts makes of it.
  latestAt(room: string) {
    return Effect.runPromise(
      Effect.flatMap(decodeRoom(room), (name) => Rooms.use((rooms) => rooms.latestAt(name))).pipe(
        Effect.provide(layerRooms),
      ),
    );
  }
}
```

## Tell another object of a change

An object telling another of its changes, as a room tells the lobby, does it as a task: give
`make` or `handlers` `tasks`, a name for each Effect, and wrap each change in
`ActionDurableObject.Tasks`' `runAfter`. The task is marked in the object's storage before the
change and again after it, and the object's alarm runs it once the call has answered, so one that
fails, or that an eviction or a crash cuts off, the change's own included, runs again until it
succeeds; the caller never fails with it, and a caller reading the object told at once may find it
not yet told. A task reads what it sends as it runs, so one run covers every change before it: the
object told ignores what it already holds, as the lobby reads the room again.

```ts example=chat-rooms/src/platform/lobby-stubs.ts
import { env } from "cloudflare:workers";
import { Effect, Layer, Schema, type Scope } from "effect";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Activity } from "../chat/activity.js";
import { RoomName } from "../chat/Chat.js";
import { Room } from "../chat/room.js";
import { LobbyCalls } from "../lobby/Calls.js";
import { LobbyHost } from "../lobby/host.js";

// The lobby is one object, named `lobby`, reached as a room is: a new stub for each call, read
// from `env` as the call is sent.
const lobbyStub = () => env.CHAT_LOBBY.getByName("lobby");

// The lobby's object as the Worker reaches it, for the previews: a lobby that cannot be reached
// is a defect, as a room is in room-stubs.ts.
export const layerLobbyHost = Layer.effect(LobbyHost)(
  Effect.map(ActionDurableObject.client(LobbyCalls), (lobby) =>
    LobbyHost.of({ previews: Effect.orDie(lobby(lobbyStub).previews()) }),
  ),
);

// The room's task, worker.ts's `lobby`: telling the lobby that the room changed, so the lobby
// reads the room again. Its type is written out because the room's class and the lobby's each
// reach the other through a binding typed by the class: inferred, each class's type would wait
// on the other's.
export const tellLobby: Effect.Effect<void, unknown, Room | Scope.Scope> = Effect.gen(function* () {
  const room = Schema.decodeUnknownSync(RoomName)(yield* Room);
  const lobby = yield* ActionDurableObject.client(LobbyCalls);

  yield* lobby(lobbyStub).roomChanged({ room });
});

// A room's activity, a startup service of the room's: each change runs the `lobby` task after it,
// on the room's alarm once the call has answered, and again until the lobby hears it, so a lobby
// that cannot be reached fails no post and misses no change. `runAfter` marks the task before the
// change and again after it, so a crash at any point leaves the task to the alarm.
export const layerActivity: Layer.Layer<Activity, never, ActionDurableObject.Tasks> = Layer.effect(
  Activity,
)(
  Effect.map(ActionDurableObject.Tasks, (tasks) =>
    Activity.of({ changing: (change) => tasks.runAfter("lobby", change) }),
  ),
);
```

`worker.ts` gives the room's class `tasks: { lobby: tellLobby }`. What a run marks, and when it
runs again, are on `ActionDurableObject.Tasks`.

## Name the object in its errors

An object reached by `getByName` knows its name, `ActionDurableObject.name`. Make it a startup
service, `Layer.effect(Room)(ActionDurableObject.name)`, as chat-rooms'
[worker.ts](../examples/chat-rooms/src/worker.ts) does, and build each error from it in the
handler, with nothing more from the caller.

An object reached by `get(idFromString(id))` has no name: its caller sends the key in the
payload, for the error to name.

## Call an object's routes

For the object's routes, `ActionHttp.client`, `ActionMcp.client`, or `ActionRpc.client` over
`RpcClient.layerProtocolHttp`, give the client `layerHttpClient(stub)`: every request goes to
the object's `fetch` in place of the network, as the example's tests call the Worker
([chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts)). Its URL and
credentials are on `ActionDurableObject.layerHttpClient`. To pass a page's request on, forward
the `Request` itself, as `worker.ts` does.
