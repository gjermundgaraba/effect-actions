import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Clock, Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { authorize } from "./authorize.js";
import { MessagePosted, Messages } from "./Chat.js";
import { MessageStore } from "./store.js";

export const messages = Action.implement(
  Messages,
  Effect.gen(function* () {
    const store = yield* MessageStore;
    const events = yield* Event.Events;

    return {
      readMessages: ({ after }) =>
        Effect.map(store.read(after), (read) => ({ messages: read })),
      postMessage: ({ text, request }) =>
        Effect.gen(function* () {
          const member = yield* CurrentMember;
          const at = yield* Clock.currentTimeMillis;

          return yield* store.post(
            { author: member.id, text, at, request },
            events.notify(MessagePosted)
          );
        }),
    };
  }),
  { authorize }
);
