import { Effect, Layer, Schema } from "effect";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { RoomName } from "../chat/Chat.js";
import { RoomPreview } from "../lobby/Lobby.js";
import { PreviewStore } from "../lobby/store.js";

const decodeLatestAt = Schema.decodeUnknownSync(Schema.UndefinedOr(RoomPreview.fields.latestAt));

// The previews in the lobby's object's synchronous key-value storage: each read and each record
// is one step no other call runs inside, so a record compares and writes what it read.
export const layerKvPreviews = Layer.effect(PreviewStore)(
  Effect.map(ActionDurableObject.State, ({ storage: { kv } }) => {
    const latestOf = (room: RoomName) => decodeLatestAt(kv.get(`preview:${room}`)) ?? null;

    return PreviewStore.of({
      read: Effect.sync(() =>
        RoomName.literals.map((room) => ({ room, latestAt: latestOf(room) })),
      ),
      record: (room, latestAt) =>
        Effect.sync(() => {
          if (latestOf(room) === latestAt) return false;

          kv.put(`preview:${room}`, latestAt);

          return true;
        }),
    });
  }),
);
