# ActionDurableObject over the stub

A **stub** is what a Worker, or another object, reaches an object through, `env.<BINDING>.getByName(name)`, and a **stub call** a call of one of the object's methods over it, with Cloudflare's own RPC, Workers RPC. An object serves rpcs on one such method, `effectActionsRpc`, named for the package so it does not collide with the class's own, and a caller calls them with a typed client whose errors are the declared ones. Read [ActionDurableObject.md](ActionDurableObject.md) first. A message the library throws says its fix; for workerd's, a compiler diagnostic or Effect's own error, search [ActionDurableObject-failures.md](ActionDurableObject-failures.md).

## Serve an object's own API over its stub

Declare what only the Worker and other objects call as a plain Effect `RpcGroup`:

```ts example=chat-rooms/src/lobby/Calls.ts
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { RoomPreview } from "./Lobby.js";

// The lobby's own API, over its stub: a room tells it its latest activity, and the Worker reads
// the previews. A plain Effect `RpcGroup`, not actions: no page calls it, so it needs no contract
// checks, no authentication and no JSON route, and nothing authenticates a stub call anyway, as
// only a binding reaches it. Why a report heard late never overwrites a later one is at
// `tellLobby`, in lobby-stubs.ts, which sends it.
export const LobbyCalls = RpcGroup.make(
  Rpc.make("roomChanged", { payload: RoomPreview }),
  Rpc.make("previews", { success: Schema.Array(RoomPreview) })
);
```

Its handlers read the store the instance built ([chat-rooms/src/lobby/handlers.ts](../examples/chat-rooms/src/lobby/handlers.ts)), and `RpcServer.layer(LobbyCalls)` over them is the object's `calls`, beside its routes ([chat-rooms/src/routes.ts](../examples/chat-rooms/src/routes.ts)), given to `make` in [chat-rooms/src/worker.ts](../examples/chat-rooms/src/worker.ts). `make` gives the calls their protocol; what crosses it, as values and not JSON, what it refuses and what the calls may require are on `ActionDurableObject.Options`' `calls`.

A plain group suits an object's own API, which no page calls. Actions served on other surfaces too are served the same way, `calls: ActionRpc.layer(RoomRpc, room)`, and called with `ActionRpc.client(RoomRpc)` over `layerStubClient(env.CHAT_ROOM.getByName(room))`: their values cross as JSON, and a protected action authenticates each call from its headers, so the caller forwards the user's credential with `RpcClient.withHeaders`.

## Call it from a Worker or another object

`client(group)` makes one client, in the caller's `Scope`, for every object of a class, and returns `(stubOf) => client`: each call gets a new stub from `stubOf`, as it is sent, and fails with the rpc's declared errors or the stub's own, an `RpcClientError`, which the caller retries or makes a defect. The Worker reads the previews through `layerLobbyHost`, and a room tells the lobby through `tellLobby`, a task, below:

```ts example=chat-rooms/src/platform/lobby-stubs.ts
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";

import { Activity } from "../chat/activity.js";
import { Room } from "../chat/room.js";
import { MessageStore } from "../chat/store.js";
import { LobbyCalls } from "../lobby/Calls.js";
import { LobbyHost } from "../lobby/host.js";

// The lobby is one object, named `lobby`: a new stub for each call, read from `env` as the call
// is sent, never as the module loads.
const lobbyStub = () => env.CHAT_LOBBY.getByName("lobby");

// The lobby's object as the Worker reaches it, for the previews: a lobby that cannot be reached
// is the deployment's failure, not the caller's, so it is a defect, the Worker answers 500, and
// the cause is in its logs.
export const layerLobbyHost = Layer.effect(LobbyHost)(
  Effect.map(ActionDurableObject.client(LobbyCalls), (lobby) =>
    LobbyHost.of({ previews: Effect.orDie(lobby(lobbyStub).previews()) })
  )
);

// The room's task, worker.ts's `lobby`: telling the lobby the room's latest activity. The room's
// alarm runs its tasks one run at a time, each waiting for the lobby's answer, and each run reads
// the activity as it is then: the lobby hears a room's reports in the order the room made them,
// so a report heard late never overwrites a later one, and the last it hears is the room's
// latest. A run repeated after a lost answer sends what the lobby holds, which `record` finds
// unchanged, notifying no page.
export const tellLobby = Effect.gen(function* () {
  const room = yield* Room;
  const latest = yield* MessageStore.use((store) => store.latest);
  const lobby = yield* ActionDurableObject.client(LobbyCalls);

  yield* lobby(lobbyStub).roomChanged({ room, latestAt: latest?.at ?? null });
});

// A room's activity, a startup service of the room's: each change runs the `lobby` task after it,
// on the room's alarm once the call has answered, and again until the lobby hears it, so a lobby
// that cannot be reached fails no post and misses no change. `runAfter` marks the task before the
// change and again after it, so a crash at any point leaves the task to the alarm.
export const layerActivity = Layer.effect(Activity)(
  Effect.map(ActionDurableObject.Tasks, (tasks) =>
    Activity.of({ changing: (change) => tasks.runAfter("lobby", change) })
  )
);
```

Why no stub is held, when one breaks and when a call may be repeated are on `ActionDurableObject.client`. `RpcClient.make` requires a `Scope` natively, so no client without one is offered. Where a Worker builds a client, as each request or once as the module loads, and why one built lazily inside a request strands, are on `ActionDurableObject.layerStubClient`'s gotchas: chat-rooms' `worker.ts` builds its handler as the module loads. In a Durable Object, `make` and `handlers` run every Effect under the scheduler that does not strand it, as `handlers` says.

A Worker's entrypoint that is no Effect program, such as a `WorkerEntrypoint` method or a queue consumer, runs each call as its own program. chat-rooms' `RoomsEntrypoint`, which `worker.ts` exports, serves the rooms' activity to another Worker:

```ts example=chat-rooms/src/rooms-entrypoint.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";

import { RoomName } from "./chat/Chat.js";
import { LobbyHost } from "./lobby/host.js";
import { layerLobbyHost } from "./platform/lobby-stubs.js";

const decodeRoom = Schema.decodeUnknownEffect(RoomName);

// The rooms' activity for another Worker, over a service binding to this one's `RoomsEntrypoint`,
// which worker.ts exports, as the lobby keeps it. A method of a `WorkerEntrypoint` is no Effect
// program, so each call runs as one, given the lobby's Layer: its client is built in the request
// that uses it and closed with it, which costs no I/O. Why a client kept across requests strands
// is on `ActionDurableObject.layerStubClient`.
export class RoomsEntrypoint extends WorkerEntrypoint {
  // The calling Worker is another deployment, so its room is checked as any input is: an unknown
  // room rejects the call with the schema's error, as a lobby that cannot be reached rejects it
  // with the defect lobby-stubs.ts makes of it.
  async latestAt(room: string) {
    return await Effect.runPromise(
      Effect.flatMap(decodeRoom(room), (name) =>
        LobbyHost.use((lobby) =>
          Effect.map(
            lobby.previews,
            (previews) =>
              previews.find((preview) => preview.room === name)?.latestAt ??
              null
          )
        )
      ).pipe(Effect.provide(layerLobbyHost))
    );
  }
}
```

## Tell another object of a change

An object telling another of its changes, as a room tells the lobby, does it as a task: give `make` or `handlers` `tasks`, a name for each Effect, and wrap each change in `ActionDurableObject.Tasks`' `runAfter`, as `layerActivity` above does. The task is marked in the object's storage before the change and again after it, and the object's alarm runs it once the call has answered, so one that fails, or that an eviction or a crash cuts off, the change's own included, runs again until it succeeds; the caller never fails with it, and a caller reading the object told at once may find it not yet told. A task reads what it sends as it runs, so one run covers every change before it, and the object told ignores what it already holds, as the lobby's `record` does. `worker.ts` gives the room's class `tasks: { lobby: tellLobby }`. What a run marks, and when it runs again, are on `ActionDurableObject.Tasks`.

## Name the object in its errors

An object reached by `getByName` knows its name, `ActionDurableObject.name`. Make it a startup service, decoded once as the instance builds, as chat-rooms' [worker.ts](../examples/chat-rooms/src/worker.ts) makes `Room`, and build each error from it in the handler, with nothing more from the caller.

An object reached by `get(idFromString(id))` has no name: its caller sends the key in the payload, for the error to name.

## Call an object's routes

For the object's routes, `ActionHttp.client`, `ActionMcp.client`, or `ActionRpc.client` over `RpcClient.layerProtocolHttp`, give the client `layerHttpClient(stub)`: every request goes to the object's `fetch` in place of the network, as the example's tests call the Worker ([chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts)). Its URL and credentials are on `ActionDurableObject.layerHttpClient`. To pass a page's request on, forward the `Request` itself, as `worker.ts` does.
