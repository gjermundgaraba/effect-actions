import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

import { ListRooms, MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

export const Rpc = ActionRpc.make([ListRooms, ...Messages, MessagePosted], {
  authentication: Login,
});
