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

// The version of these rpcs a page was built with, which it names in its socket's URL, and the
// close code a room answers a page naming another with: raise the version when a change would
// break a page still open from before a deployment.
export const protocolVersion = "1";

export const unsupportedProtocol = 4000;
