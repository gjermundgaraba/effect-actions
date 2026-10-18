import { Effect, Layer } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { LobbyHttp, RoomHttp } from "./Api.js";
import { messagesIn, preview } from "./chat/handlers.js";
import { Room } from "./chat/room.js";
import { authenticate } from "./identity/verifier.js";
import { lobby } from "./lobby/handlers.js";
import { RoomRpc } from "./Rpc.js";

// What a room's object serves, built for the room the instance holds. Its rpcs on WebSockets
// the runtime holds while the object hibernates: a socket keeps the token its upgrade request
// carried, and each message is authenticated with it, or with the message's own. Its JSON
// routes at `/api/<action>`. It requires `Room` and `MessageStore` at startup: worker.ts
// chooses them.
export const roomRoutes = Layer.unwrap(
  Effect.map(Effect.service(Room), (room) => {
    const served = [preview, messagesIn(room)];

    return Layer.mergeAll(
      ActionRpc.layer(RoomRpc, served).pipe(
        Layer.provide(ActionDurableObject.layerWebSocket(RoomRpc, { path: "/rpc" })),
      ),
      ActionHttp.layer(RoomHttp, served),
    );
  }),
).pipe(Layer.provide(authenticate));

// What the Worker serves itself: the lobby, which asks the rooms' objects. It requires `Rooms`.
export const lobbyRoutes = ActionHttp.layer(LobbyHttp, lobby);
