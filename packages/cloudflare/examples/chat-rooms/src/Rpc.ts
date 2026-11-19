import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

import { MessagePosted } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

export const RoomSocket = ActionRpc.make([MessagePosted], {
  authentication: Login,
});

export const protocolVersion = "2";

export const unsupportedProtocol = 4000;
