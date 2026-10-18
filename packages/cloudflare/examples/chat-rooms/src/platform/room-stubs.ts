import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { RoomHttp } from "../Api.js";
import { Rooms } from "../lobby/rooms.js";

// The rooms through their objects' stubs: each call is the room's own JSON route, with its
// typed client, sent to the object in place of the network, so the URL's host is never looked
// up. `preview` is public, so the Worker sends no credential.
export const layerRooms = Layer.sync(Rooms, () =>
  Rooms.of({
    latest: (room) =>
      ActionHttp.client(RoomHttp, { baseUrl: "https://room" }).pipe(
        Effect.flatMap((client) => client.preview()),
        Effect.map(({ latest }) => latest),
        Effect.provide(ActionDurableObject.layerHttpClient(env.CHAT_ROOM.getByName(room))),
        // A room that cannot be reached is the deployment's failure, not the caller's: the
        // lobby answers 500, and the cause is in the Worker's logs.
        Effect.orDie,
      ),
  }),
);
