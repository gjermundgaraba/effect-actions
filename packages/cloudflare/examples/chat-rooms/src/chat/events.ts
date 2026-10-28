import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Option, Schema } from "effect";

import { authorize } from "./authorize.js";
import { MessagePosted } from "./Chat.js";
import { MessageStore } from "./store.js";

const idOf = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt()))
);

const nextPoll = "30 seconds";

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
