import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Messages, Preview } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

// A room's rpcs, on the socket a page keeps open to its object, and over its stub for the
// Worker. Plain data: the object, the Worker and a browser page all import it.
export const RoomRpc = ActionRpc.make([Preview, ...Messages], { authentication: Login });
