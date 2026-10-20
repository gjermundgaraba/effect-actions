import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Rooms } from "../lobby/rooms.js";
import { RoomRpc } from "../Rpc.js";

// The rooms through their objects' stubs: each call is the room's own rpc, with its typed
// client, sent as one call of the object's stub method, Cloudflare's own RPC, never its
// `fetch`. `preview` is public, so the Worker sends no credential. A client is made per call,
// in its own scope: it is a few objects, and the stub is the room's, by name.
export const layerRooms = Layer.sync(Rooms, () =>
  Rooms.of({
    latestAt: (room) =>
      ActionRpc.client(RoomRpc).pipe(
        Effect.flatMap((client) => client.preview()),
        Effect.map(({ latestAt }) => latestAt),
        Effect.scoped,
        Effect.provide(ActionDurableObject.layerStubClient(env.CHAT_ROOM.getByName(room))),
        // A room that cannot be reached is the deployment's failure, not the caller's: the
        // lobby answers 500, and the cause is in the Worker's logs.
        Effect.orDie,
      ),
  }),
);
