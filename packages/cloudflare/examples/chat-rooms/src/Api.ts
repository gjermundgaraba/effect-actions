import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

import { MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";
import { Previews } from "./lobby/Lobby.js";

export const RoomHttp = ActionHttp.make([...Messages, MessagePosted], {
  authentication: Login,
});

export const LobbyHttp = ActionHttp.make([Previews]);
