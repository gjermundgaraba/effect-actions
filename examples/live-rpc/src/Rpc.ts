import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

import { ListRooms, MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

// The RPC binding: one native rpc per action, named after it, and a stream rpc for
// `MessagePosted`, the protected ones requiring `Login`. It is plain data and imports no server
// code, so the server and a browser page both import this one value. `Rpc.group` is the native
// `RpcGroup`, for Effect's own `RpcClient.make`.
export const Rpc = ActionRpc.make([ListRooms, ...Messages, MessagePosted], {
  authentication: Login,
});
