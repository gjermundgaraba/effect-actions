import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Effect, Layer, Schema } from "effect";

import { DemoRoomName } from "../chat/Chat.js";
import { RoomPreview } from "../lobby/Lobby.js";
import { PreviewStore } from "../lobby/store.js";

const decodeLatestAt = Schema.decodeUnknownSync(
  Schema.UndefinedOr(RoomPreview.fields.latestAt)
);

export const layerKvPreviews = Layer.effect(PreviewStore)(
  Effect.map(ActionDurableObject.State, ({ storage: { kv } }) => {
    const latestOf = (room: DemoRoomName) =>
      decodeLatestAt(kv.get(`preview:${room}`)) ?? null;

    return PreviewStore.of({
      read: Effect.sync(() =>
        DemoRoomName.literals.map((room) => ({
          room,
          latestAt: latestOf(room),
        }))
      ),
      record: (room, latestAt) =>
        Effect.sync(() => {
          if (latestOf(room) === latestAt) {
            return false;
          }

          kv.put(`preview:${room}`, latestAt);

          return true;
        }),
    });
  })
);
