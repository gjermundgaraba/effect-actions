import { Context, Effect, Layer } from "effect";
import { RpcMiddleware } from "effect/rpc";
import { defaultRoom, roomHeader } from "./Chat.js";

/**
 * The room a message is about. A request-time service: handlers and `authorize` read it per
 * call, and it has no Layer, because no one value of it is right for a whole server.
 */
export class CurrentRoom extends Context.Service<CurrentRoom, string>()("live-rpc/CurrentRoom") {}

// Native Effect RPC middleware, declared as providing `CurrentRoom`. Listed in
// `ActionRpc.layer`'s `middleware`, it runs once per message.
export class ResolveRoom extends RpcMiddleware.Service<ResolveRoom, { provides: CurrentRoom }>()(
  "live-rpc/ResolveRoom",
) {}

// The middleware's implementation. It gets the message's headers, which over a WebSocket are
// the upgrade request's merged with the message's own, and runs the rest of the call with the
// room they name, or the default room when they name none. It refuses nothing: whether the
// caller may be in that room is `authorize`'s rule.
export const resolveRoom = Layer.succeed(ResolveRoom, (call, { headers }) =>
  Effect.provideService(call, CurrentRoom, headers[roomHeader] ?? defaultRoom),
);
