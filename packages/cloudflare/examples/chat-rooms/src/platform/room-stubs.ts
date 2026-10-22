import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { RoomCalls } from "../chat/Calls.js";
import { Rooms } from "../lobby/rooms.js";

// The rooms through their objects' stubs: each call is one of the room's own calls, sent with
// Cloudflare's own RPC, never its `fetch`. One client serves every room, and each call gets a
// new stub from the function it is given, as it is sent: an exception can leave a stub broken,
// failing every later call through it, so none is held. The function reads `env` as the call
// is sent, never as the module loads. A room that cannot be reached is the deployment's
// failure, not the caller's: the client makes it a defect, so the lobby answers 500, and the
// cause is in the Worker's logs.
export const layerRooms = Layer.effect(Rooms)(
  Effect.map(ActionDurableObject.client(RoomCalls), (room) =>
    Rooms.of({ latestAt: (name) => room(() => env.CHAT_ROOM.getByName(name)).latestAt() }),
  ),
);
