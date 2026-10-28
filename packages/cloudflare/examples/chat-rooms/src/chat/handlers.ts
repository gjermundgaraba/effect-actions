import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { Activity } from "./activity.js";
import { authorize } from "./authorize.js";
import { MessagePosted, Messages } from "./Chat.js";
import { MessageStore } from "./store.js";

export const messages = Action.implement(
  Messages,
  Effect.gen(function* () {
    const store = yield* MessageStore;
    const events = yield* Event.Events;
    const activity = yield* Activity;

    return {
      readMessages: ({ after }) =>
        Effect.map(store.read(after), (read) => ({ messages: read })),
      postMessage: ({ text }) =>
        Effect.flatMap(CurrentMember, (member) =>
          store.post(member.id, text)
        ).pipe(Effect.tap(events.notify(MessagePosted)), activity.changing),
      deleteMessage: ({ id }) =>
        activity.changing(
          Effect.flatMap(CurrentMember, (member) => store.remove(member.id, id))
        ),
    };
  }),
  { authorize }
);
