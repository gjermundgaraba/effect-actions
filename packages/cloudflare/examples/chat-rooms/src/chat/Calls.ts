import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

// A room's own API, which only the Worker calls, over the room's stub with Cloudflare's own
// RPC. A plain Effect `RpcGroup`, not actions: no page calls it, so it needs no contract
// checks, no authentication and no JSON route, and nothing authenticates a stub call anyway,
// as only a binding reaches it. The room's object and the Worker both import it.
export const RoomCalls = RpcGroup.make(
  Rpc.make("latestAt", { success: Schema.NullOr(Schema.Int) }),
);
