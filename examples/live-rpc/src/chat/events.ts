import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Option, Schema } from "effect";

import { authorize } from "./authorize.js";
import { MessagePosted } from "./Chat.js";
import { CurrentRoom } from "./room.js";
import { MessageStore } from "./store.js";

const idOf = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt()))
);

// A cursor this source gives is `<epoch>:<id>`, the store's epoch and the id of the last message
// a page holds, so one from before a restart of the memory store is told apart. A page starting
// a watch gives the id alone, as `readMessages`' `after` is, which is the store's now.
const positionOf = (epoch: string, cursor: string | null) => {
  const parts =
    cursor?.includes(":") === true ? cursor.split(":") : [epoch, cursor];

  return parts.length === 2 && parts[0] === epoch
    ? idOf(parts[1])
    : Option.none();
};

// The room's messages as an event, read from the store that keeps them: a check source.
// `postMessage` notifies after each post, so a page receives it at once, not at its next read
// every 5 seconds.
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

          // No cursor starts after the room's last message. One this room never gave, such as
          // one from before a restart, is answered `truncated` from there: the page learns its
          // messages may be another run's, and reads the room again with `readMessages`.
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
            // A message's id counts within its room and the store's epoch, so the event's id
            // names all three: a watch drops an id it has seen, and after a restart of the memory
            // store `lobby:1` is another message.
            events: messages.map((data) => ({
              eventId: `${store.epoch}:${room}:${data.id}`,
              data,
            })),
          };
        }),
      // A notify for one room wakes that room's pages alone: the key is the room the watch's
      // header names, read as `check` reads it.
      key: () => CurrentRoom,
    };
  }),
  { authorize }
);
