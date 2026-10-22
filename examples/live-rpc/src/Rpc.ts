import { RpcGroup } from "effect/rpc";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { ListRooms, Messages, Watch } from "./chat/Chat.js";
import { ResolveRoom } from "./chat/room.js";
import { Login } from "./identity/Identity.js";

// The RPC binding: one native rpc per action, named after it, the protected ones requiring
// `Login`, and `watch`, a native rpc of its own, which streams. It is plain data and imports no
// server code, so the server and a browser page both import this one value. `Rpc.group` is the
// native `RpcGroup`, for Effect's own `RpcClient.make`. `ActionRpc.layer`'s `middleware` runs on
// actions alone, so `watch`'s group adds the room's middleware itself.
export const Rpc = ActionRpc.make([ListRooms, ...Messages], {
  authentication: Login,
  rpcs: RpcGroup.make(Watch).middleware(ResolveRoom),
});
