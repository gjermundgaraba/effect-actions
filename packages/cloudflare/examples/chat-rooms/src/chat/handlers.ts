import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { CurrentMember } from "../identity/Identity.js";
import { Activity } from "./activity.js";
import { authorize } from "./authorize.js";
import { MessagePosted, Messages } from "./Chat.js";
import { MessageStore } from "./store.js";

// The builder runs once per instance, when the object is constructed, and again on the
// instance the runtime constructs after evicting one: it is where a handler gets its startup
// services. The caller is read per call, because every message has its own.
export const messages = Action.implement(
  Messages,
  Effect.gen(function* () {
    const store = yield* MessageStore;
    const events = yield* Event.Events;
    const activity = yield* Activity;

    return {
      readMessages: ({ after }) => Effect.map(store.read(after), (messages) => ({ messages })),
      // The message is in the store, which `MessagePosted`'s check reads: notifying wakes the
      // pages watching the room to read it now. The lobby is another object, whose event this
      // one cannot notify: the room tells it over its stub instead, and the lobby notifies.
      postMessage: ({ text }) =>
        Effect.flatMap(CurrentMember, (member) => store.post(member.id, text)).pipe(
          Effect.tap(events.notify(MessagePosted)),
          activity.changing,
        ),
      deleteMessage: ({ id }) =>
        activity.changing(Effect.flatMap(CurrentMember, (member) => store.remove(member.id, id))),
    };
  }),
  { authorize },
);
