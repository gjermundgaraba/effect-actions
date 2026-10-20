import { RpcGroup } from "effect/rpc";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Messages, Preview, Watch } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

// A room's rpcs, on the socket a page keeps open to its object: its actions, and `watch`, which
// streams. Plain data: the object and a browser page both import it.
export const RoomRpc = ActionRpc.make([Preview, ...Messages], {
  authentication: Login,
  rpcs: RpcGroup.make(Watch),
});
