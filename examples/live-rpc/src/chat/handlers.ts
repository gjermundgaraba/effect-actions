import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "../identity/Identity.js";
import { authorize } from "./authorize.js";
import { ListRooms, Messages } from "./Chat.js";
import { CurrentRoom } from "./room.js";
import { MessageStore } from "./store.js";

// A public action takes no `authorize`: nothing would run it.
export const rooms = Action.implement(
  ListRooms,
  Effect.gen(function* () {
    const store = yield* MessageStore;

    return () => Effect.map(store.rooms, (found) => ({ rooms: found }));
  }),
);

// The builder runs once, at startup: it is where a handler gets its services. The caller and
// the room are read per call, inside each handler, because every message has its own.
export const messages = Action.implement(
  Messages,
  Effect.gen(function* () {
    const store = yield* MessageStore;

    return {
      readMessages: ({ after }) =>
        Effect.gen(function* () {
          const room = yield* CurrentRoom;

          return { messages: yield* store.read(room, after) };
        }),
      postMessage: ({ text }) =>
        Effect.gen(function* () {
          const room = yield* CurrentRoom;
          const member = yield* CurrentMember;

          return yield* store.post(room, member.id, text);
        }),
      deleteMessage: ({ id }) =>
        Effect.gen(function* () {
          const room = yield* CurrentRoom;
          const member = yield* CurrentMember;

          return yield* store.remove(room, member.id, id);
        }),
    };
  }),
  { authorize },
);
