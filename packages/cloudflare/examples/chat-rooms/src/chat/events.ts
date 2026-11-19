import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { authorize } from "./authorize.js";
import { MessagePosted } from "./Chat.js";
import { MessageStore } from "./store.js";

export const messageEvents = Event.implement(
  MessagePosted,
  Effect.map(MessageStore, (store) =>
    Event.appended(MessagePosted, {
      newest: () => store.last,
      after: (_input, id) => Effect.map(store.read(id), (items) => ({ items })),
      id: (message) => message.id,
      notified: true,
      nextPoll: "2 seconds",
    })
  ),
  { authorize }
);
