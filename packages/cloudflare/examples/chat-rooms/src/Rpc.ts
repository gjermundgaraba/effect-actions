import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

import { MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

export const RoomRpc = ActionRpc.make([...Messages, MessagePosted], {
  authentication: Login,
});

export const protocolVersion = "1";

export const unsupportedProtocol = 4000;
