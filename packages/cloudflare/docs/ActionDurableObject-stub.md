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

Why no stub is held, and when one breaks, are on `ActionDurableObject.client`; for Effect's own
typing, with `RpcClientError` in every call's errors, `RpcClient.make(group)` over
`layerStubClient(stub)`, whose stub it holds. From another object, make the client in a startup
service.

## Name the object in its errors

An object reached by `getByName` knows its name, `State`'s `id.name`. Make it a startup
service, dying without one, and build each error from it in the handler, with nothing more
from the caller:

```ts example=chat-rooms/src/platform/object-name.ts
import { Effect, Layer } from "effect";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Room } from "../chat/room.js";

// The room an instance holds is the name the Worker reached its object by, `getByName(room)`.
// An object reached by an id has none, which is a bug in the Worker.
export const layerRoom = Layer.effect(Room)(
  Effect.flatMap(Effect.service(ActionDurableObject.State), ({ id }) =>
    Effect.fromNullishOr(id.name).pipe(Effect.orDie),
  ),
);
```

An object reached by `get(idFromString(id))` has no name: its caller sends the key in the
payload, for the error to name.

## Call an object's routes

For the object's routes, `ActionHttp.client`, `ActionMcp.client`, or `ActionRpc.client` over
`RpcClient.layerProtocolHttp`, give the client `layerHttpClient(stub)`: every request goes to
the object's `fetch` in place of the network, as the example's tests call the Worker
([chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts)). Its URL and
credentials are on `ActionDurableObject.layerHttpClient`. To pass a page's request on, forward
the `Request` itself, as `worker.ts` does.
