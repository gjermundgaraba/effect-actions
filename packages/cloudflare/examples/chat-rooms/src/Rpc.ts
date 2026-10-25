import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { MessagePosted, Messages, Preview } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";
import { PreviewsChanged } from "./lobby/Lobby.js";

// A room's rpcs and its event, on the socket a page keeps open to its object. Plain data: the
// object and a browser page both import it.
export const RoomRpc = ActionRpc.make([Preview, ...Messages, MessagePosted], {
  authentication: Login,
});

// The lobby's event, on the socket a page keeps open to the lobby's object: public, so a page
// signed out follows it, and refused at another version as a room's socket is.
export const LobbyRpc = ActionRpc.make([PreviewsChanged]);

// The version of these rpcs a page was built with, which it names in its socket's URL, and the
// close code an object answers a page naming another with: raise the version when a change would
// break a page still open from before a deployment.
export const protocolVersion = "1";

export const unsupportedProtocol = 4000;
