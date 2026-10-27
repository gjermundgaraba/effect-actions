import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

import { MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";
import { Previews } from "./lobby/Lobby.js";

// The rooms' JSON routes, at `/api/<action>` and `/api/events/<name>`: the Worker's, which a
// client without a socket calls, and each room's object's, where the Worker sends each call on.
export const RoomHttp = ActionHttp.make([...Messages, MessagePosted], {
  authentication: Login,
});

// The Worker's own JSON routes.
export const LobbyHttp = ActionHttp.make([Previews]);
