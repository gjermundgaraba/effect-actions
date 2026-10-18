import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "../identity/Identity.js";
import { authorize } from "./authorize.js";
import { Messages, Preview } from "./Chat.js";
import { MessageStore } from "./store.js";

// A public action takes no `authorize`: nothing would run it.
export const preview = Action.implement(
  Preview,
  Effect.gen(function* () {
    const store = yield* MessageStore;

    return () => Effect.map(store.latest, (latest) => ({ latest }));
  }),
);

// The builder runs once per instance, when the object is constructed, and again on the
// instance the runtime constructs after evicting one: it is where a handler gets its startup
// services. The caller is read per call, because every message has its own.
export const messages = Action.implement(
  Messages,
  Effect.gen(function* () {
    const store = yield* MessageStore;

    return {
      readMessages: ({ after }) => Effect.map(store.read(after), (read) => ({ messages: read })),
      postMessage: ({ text }) =>
        Effect.flatMap(CurrentMember, (member) => store.post(member.id, text)),
      deleteMessage: ({ id }) =>
        Effect.flatMap(CurrentMember, (member) => store.remove(member.id, id)),
    };
  }),
  { authorize },
);
