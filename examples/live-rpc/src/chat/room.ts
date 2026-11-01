import { Context, Effect, Layer } from "effect";
import { RpcMiddleware } from "effect/rpc";

import { defaultRoom, roomHeader } from "./Chat.js";

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
