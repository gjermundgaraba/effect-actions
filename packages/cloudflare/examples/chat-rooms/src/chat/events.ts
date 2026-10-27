import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Option, Schema } from "effect";

import { authorize } from "./authorize.js";
import { MessagePosted } from "./Chat.js";
import { MessageStore } from "./store.js";

// A cursor is the id of the last message a page holds, as `readMessages`' `after` is.
const idOf = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt()))
);

// An agent polling over MCP asks again after `nextPoll`, 5 seconds by default: a request that
// often keeps the object from the 10 idle seconds after which the runtime may hibernate it, so it
// asks every 30 seconds, and an agent that needs a message sooner holds a stream open instead.
const nextPoll = "30 seconds";

// The room's messages as an event, read from the store that keeps them: a check source.
// `postMessage` notifies after each post, so a page receives it at once: when an object reads a
// check source, and what a write that does not notify misses, is on `ActionDurableObject.handlers`.
export const messageEvents = Event.implement(
  MessagePosted,
  Effect.gen(function* () {
    const store = yield* MessageStore;

    return {
      check: (_input, cursor) =>
        Effect.gen(function* () {
          const last = yield* store.last;

          const after = Option.filter(
            idOf(cursor),
            (id) => id >= 0 && id <= last
          );

          // No cursor starts after the room's last message. One this room never gave, such as
          // an id past its last from another copy of its database, is answered `truncated` from
          // there: the page learns it missed messages, and reads them with `readMessages`. A
          // message deleted or expired after a cursor is simply not read: the store keeps no
          // record of either, so no gap marks it.
          if (Option.isNone(after)) {
            return {
              cursor: String(last),
              events: [],
              truncated: cursor !== null,
              nextPoll,
            };
          }

          const messages = yield* store.read(after.value);

          return {
            cursor: String(messages.at(-1)?.id ?? after.value),
            events: messages.map((data) => ({
              eventId: String(data.id),
              data,
            })),
            nextPoll,
          };
        }),
    };
  }),
  { authorize }
);
