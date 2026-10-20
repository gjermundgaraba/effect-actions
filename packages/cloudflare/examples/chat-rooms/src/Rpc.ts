import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Messages, Preview } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

// A room's rpcs, on the socket a page keeps open to its object. Plain data: the object and a
// browser page both import it.
export const RoomRpc = ActionRpc.make([Preview, ...Messages], { authentication: Login });
