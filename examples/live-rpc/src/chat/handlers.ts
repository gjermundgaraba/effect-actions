import { Effect, Stream } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Feed from "@gjermundgaraba/effect-actions/Feed";
import { CurrentMember } from "../identity/Identity.js";
import { Rpc } from "../Rpc.js";
import { authorize } from "./authorize.js";
import { ListRooms, Messages, Watch } from "./Chat.js";
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

// The builder runs once, at startup: it is where a handler gets its startup services. The
// caller and the room are read per call, inside each handler, because every message has its own.
export const messages = Action.implement(
  Messages,
  Effect.gen(function* () {
    const store = yield* MessageStore;
    const feed = yield* Feed.Feed;

    return {
      readMessages: ({ after }) =>
        Effect.gen(function* () {
          const room = yield* CurrentRoom;

          return { messages: yield* store.read(room, after) };
        }),
      // A message posted goes to every page following its room, the feed's key.
      postMessage: ({ text }) =>
        Effect.gen(function* () {
          const room = yield* CurrentRoom;
          const member = yield* CurrentMember;
          const message = yield* store.post(room, member.id, text);

          yield* feed.publish(Watch, message, { key: room });

          return message;
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

// A page's `watch`: its room's messages after the last one it holds, then each one posted
// there. Implemented on the binding's own `rpcs`, which provide `CurrentMember` per message, as
// an action's authentication does, and `CurrentRoom`, through the group's middleware. A native
// rpc runs no `authorize`, so its handler runs the one rule first, as the actions do. The rule
// runs as the page subscribes, not for each message: a member removed from the room goes on
// receiving until the page stops, unless the room ends their `watch`, by a key of their own.
export const watch = Rpc.rpcs.toLayer(
  Effect.gen(function* () {
    const store = yield* MessageStore;
    const feed = yield* Feed.Feed;

    return {
      watch: ({ after }, request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* authorize();

            const room = yield* CurrentRoom;

            return feed.subscribe(request, { initial: store.read(room, after), key: room });
          }),
        ),
    };
  }),
);
