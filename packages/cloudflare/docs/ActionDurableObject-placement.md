# ActionDurableObject: placement

A **placement** says which Durable Object serves each call and each watch of an HTTP binding's contracts: the one its contract's **key** names for its input, `getByName(key(input))`. The Worker serves the contracts on any surface without implementing them, sending each call on to its object, so one client, or one agent's MCP connection, reaches every object. Read [ActionDurableObject.md](ActionDurableObject.md) first; what the Worker sends on and what comes back is on the core's `ActionHttp.placed`, which this builds on.

## Place a binding's contracts in objects

Each contract names its object in its input, chat-rooms' room in every action and in `MessagePosted`, and one HTTP binding holds them, served by the Worker and by each object alike:

```ts example=chat-rooms/src/Api.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

import { MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";
import { Previews } from "./lobby/Lobby.js";

// The rooms' JSON routes, at `/api/<action>` and `/api/events/<name>`: the Worker's, which a
// client without a socket calls, and each room's object's, where the Worker sends each call on.
export const RoomHttp = ActionHttp.make([...Messages, MessagePosted], {
  authentication: Login,
});

// The Worker's own JSON routes.
export const LobbyHttp = ActionHttp.make([Previews]);
```

Then, as `routes.ts` on [ActionDurableObject.md](ActionDurableObject.md) does:

- `ActionDurableObject.placed(RoomHttp, { readMessages: byRoom, … })` is the placement, shared by both sides: a key for each contract of the binding, by its name, each reading its own contract's input, so a contract added to the binding without one is a type error.
- Each object's routes serve the binding in `ActionHttp.layer`, where each call arrives, beside whatever else they serve, a page's socket among them.
- The class is given the placement as `make`'s `placed`, in `worker.ts`: the object then refuses `Forbidden`, on every surface, its socket and its stub included, a call or a watch whose key names another object, so a page's socket to one room cannot reach another.
- The Worker serves `ActionDurableObject.reaching(rooms, () => env.CHAT_ROOM)` beside its own implementations, in `ActionHttp.layer` and `ActionMcp.layerHttp`, each call sent to the room's object with the caller's headers.

The Worker authenticates each protected call as its own, and the object authenticates and authorizes it again, so both are given the verifier. A key's schema, `RoomName` in `Chat.ts`, is what keeps a caller from creating objects: an unknown room is `InvalidInput` before any object is reached. [chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts) reaches two rooms through one MCP connection and has a room refuse a call naming another.

## Serve them over MCP from the Worker

Nothing in a Worker outlives a request, so its MCP endpoint is `requestScoped`, as `routes.ts`'s is: MCP 2026-07-28 alone, and an event by `events/poll` alone, since a request-scoped server pushes nothing. An event that agents follow by stream or by webhook is served from its object's own endpoint instead, as [ActionDurableObject-events.md](ActionDurableObject-events.md) shows, one connection per object. Where every event lives in one object, such as a single lobby, that object serves the one MCP endpoint, its own implementations beside `reaching` the other objects' actions, and the Worker forwards `/mcp` to it.

## What a watch through the Worker costs

Cloudflare bills a Worker for its requests and CPU time, not for how long a request stays open, and an object for the wall-clock time it is active or cannot hibernate, as its pricing page says. A watch held through the Worker, an HTTP client's stream, holds a request to the object open for as long as it lasts, so the object is billed for all of it; a poll lets it hibernate between requests. An event an object's socket serves through a placement of another object's holds both awake: serve an event in the object whose socket follows it, as `ActionDurableObject.reaching` says.
