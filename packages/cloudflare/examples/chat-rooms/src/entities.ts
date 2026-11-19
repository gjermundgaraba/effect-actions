import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";

import { MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

export const Room = ActionEntity.make("Room", [...Messages, MessagePosted], {
  authentication: Login,
  key: ({ room }) => room,
});
