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
protocol, `layerStub()`; what crosses it, as values and not JSON, and what it refuses, are on
`ActionDurableObject.layerStub`, and what the calls may require on
`ActionDurableObject.Options`' `calls`.

A plain group suits an object's own API, which no page calls. Actions served on other surfaces
too are served the same way, `calls: ActionRpc.layer(RoomRpc, room)`, and called with
`ActionRpc.client(RoomRpc)` over `layerStubClient(env.CHAT_ROOM.getByName(room))`: their
values cross as JSON, and a protected action authenticates each call from its headers, so the
caller forwards the user's credential with `RpcClient.withHeaders`.

## Call it from the Worker

`client(group)` makes one client, in the caller's `Scope`, for every object of a class, and
returns `(stubOf) => client`: each call gets a new stub from `stubOf`, as it is sent, and fails
with the rpc's declared errors alone.

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
// is sent, never as the module loads. A room that cannot be reached is the deployment's
// failure, not the caller's: the client makes it a defect, so the lobby answers 500, and the
// cause is in the Worker's logs.
export const layerRooms = Layer.effect(Rooms)(
  Effect.map(ActionDurableObject.client(RoomCalls), (room) =>
    Rooms.of({ latestAt: (name) => room(() => env.CHAT_ROOM.getByName(name)).latestAt() }),
  ),
);
```

Why no stub is held, and when one breaks, are on `ActionDurableObject.client`. For Effect's own
typing, with `RpcClientError` in every call's errors and a retry of your own, build
`RpcClient.make(group)` over `layerStubClient(() => env.CHAT_ROOM.getByName(room))`, which calls
the function as each call is sent, as `client` does. From another object, make the client in a startup
service. `RpcClient.make` requires a `Scope` natively, so no client without one is offered.

In a Worker, build a runtime or handler kept across requests when the module loads, as chat-rooms'
[worker.ts](../examples/chat-rooms/src/worker.ts) builds its lobby, or run each call as its own
program given the client's Layer; never build one lazily inside a request. A client forks its
own fiber on a timer of the request that builds it, and workerd drops a request's timers when it
ends: a client first built inside a request that ends without waiting on I/O, succeeding or
refused, never starts that fiber, and every later call through it waits until workerd cancels
it as hung. `HttpRouter.toWebHandler` builds its Layer as it is called, so one called as the module
loads needs nothing more, which is why the lobby is the safe example, and one called lazily
inside a request fails the same way. `ManagedRuntime.make(layer)` builds nothing until its
first run, so one made at module scope is still built inside the first request: run it once as
the module loads, `runtime.runFork(Effect.void)`, which one probe under `vitest-pool-workers`
found enough, or prefer a program per call. A Durable Object's build on its first event does not:
workerd keeps an object's I/O context across its events, so the timer fires in a later one.

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
// it, which costs no I/O. A runtime kept across requests is built as the module loads instead,
// as worker.ts builds the lobby: one first built inside a request that ends without waiting on
// I/O, succeeding or refused, never starts its client's own fiber, and every later call through
// it waits for good. `ManagedRuntime.make` at module scope builds nothing until its first run,
// inside a request, so it is that lazy form unless it is run once as the module loads.
export class RoomsEntrypoint extends WorkerEntrypoint<Cloudflare.Env> {
  // The calling Worker is another deployment, so its room is checked as any input is: an unknown
  // room rejects the call with the schema's error, as a room that cannot be reached rejects it
  // with the defect.
  latestAt(room: string) {
    return Effect.runPromise(
      Effect.flatMap(decodeRoom(room), (name) => Rooms.use((rooms) => rooms.latestAt(name))).pipe(
        Effect.provide(layerRooms),
      ),
    );
  }
}
```

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
