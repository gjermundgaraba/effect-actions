import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Messages, Preview } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";
import { Previews } from "./lobby/Lobby.js";

// A room's JSON routes, at `/api/<action>` inside its object: a client without a socket posts
// with them.
export const RoomHttp = ActionHttp.make([Preview, ...Messages], { authentication: Login });

// The Worker's own JSON routes.
export const LobbyHttp = ActionHttp.make([Previews]);
