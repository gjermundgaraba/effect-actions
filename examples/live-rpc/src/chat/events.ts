import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Option, Schema } from "effect";

import { authorize } from "./authorize.js";
import { MessagePosted } from "./Chat.js";
import { CurrentRoom } from "./room.js";
import { MessageStore } from "./store.js";

const idOf = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt()))
);

const positionOf = (epoch: string, cursor: string | null) => {
  const parts =
    cursor?.includes(":") === true ? cursor.split(":") : [epoch, cursor];

  return parts.length === 2 && parts[0] === epoch
    ? idOf(parts[1])
    : Option.none();
};

export const messageEvents = Event.implement(
  MessagePosted,
  Effect.gen(function* () {
    const store = yield* MessageStore;

    return {
      check: (_input, cursor) =>
        Effect.gen(function* () {
          const room = yield* CurrentRoom;
          const last = yield* store.last(room);

          const after = Option.filter(
            positionOf(store.epoch, cursor),
            (id) => id >= 0 && id <= last
          );

          if (Option.isNone(after)) {
            return {
              cursor: `${store.epoch}:${last}`,
              events: [],
              truncated: cursor !== null,
            };
          }

          const messages = yield* store.read(room, after.value);

          return {
            cursor: `${store.epoch}:${messages.at(-1)?.id ?? after.value}`,
            events: messages.map((data) => ({
              eventId: `${store.epoch}:${room}:${data.id}`,
              data,
            })),
          };
        }),
      key: () => CurrentRoom,
    };
  }),
  { authorize }
);
