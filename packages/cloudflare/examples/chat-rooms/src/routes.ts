import { Layer } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { LobbyHttp, RoomHttp } from "./Api.js";
import { messages, preview } from "./chat/handlers.js";
import { authenticate } from "./identity/verifier.js";
import { lobby } from "./lobby/handlers.js";
import { RoomRpc } from "./Rpc.js";

const room = [preview, messages];

// What a room's object serves. Its rpcs on WebSockets the runtime holds while the object
// hibernates: a socket keeps the token its upgrade request carried, and each message is
// authenticated with it, or with the message's own. Its JSON routes at `/api/<action>`. It
// requires `MessageStore` and `Room` at startup: worker.ts chooses them.
export const roomRoutes = Layer.mergeAll(
  ActionRpc.layer(RoomRpc, room).pipe(
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
  ),
  ActionHttp.layer(RoomHttp, room),
).pipe(Layer.provide(authenticate));

// What the Worker serves itself: the lobby, which asks the rooms' objects. It requires `Rooms`.
export const lobbyRoutes = ActionHttp.layer(LobbyHttp, lobby);
