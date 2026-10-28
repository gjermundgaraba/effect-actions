import { Context, Effect, Layer } from "effect";
import { RpcMiddleware } from "effect/rpc";

import { defaultRoom, roomHeader } from "./Chat.js";

/**
 * The room a message is about. A request-time service: handlers and `authorize` read it per
 * call, and it has no Layer, because no one value of it is right for a whole server.
 */
export class CurrentRoom extends Context.Service<CurrentRoom, string>()(
  "live-rpc/CurrentRoom"
) {}

export class ResolveRoom extends RpcMiddleware.Service<
  ResolveRoom,
  { provides: CurrentRoom }
>()("live-rpc/ResolveRoom") {}

export const resolveRoom = Layer.succeed(ResolveRoom, (call, { headers }) =>
  Effect.provideService(call, CurrentRoom, headers[roomHeader] ?? defaultRoom)
);
