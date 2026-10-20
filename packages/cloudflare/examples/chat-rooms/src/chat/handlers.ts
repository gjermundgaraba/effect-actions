import { Effect, Stream } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { CurrentMember } from "../identity/Identity.js";
import { RoomRpc } from "../Rpc.js";
import { authorize } from "./authorize.js";
import { RoomCalls } from "./Calls.js";
import { Messages, Preview, Watch } from "./Chat.js";
import { MessageStore } from "./store.js";

// A public action takes no `authorize`: nothing would run it.
export const preview = Action.implement(
  Preview,
  Effect.gen(function* () {
    const store = yield* MessageStore;

    return () => Effect.map(store.latest, (latest) => ({ latestAt: latest?.at ?? null }));
  }),
);

// The builder runs once per instance, when the object is constructed, and again on the
// instance the runtime constructs after evicting one: it is where a handler gets its startup
// services. The caller is read per call, because every message has its own.
export const messages = Action.implement(
  Messages,
  Effect.gen(function* () {
    const store = yield* MessageStore;
    const feed = yield* ActionDurableObject.Feed;

    return {
      // Posted over the socket or the JSON routes, a message goes to every page following the
      // room, as one chunk of its `watch`.
      postMessage: ({ text }) =>
        Effect.flatMap(CurrentMember, (member) => store.post(member.id, text)).pipe(
          Effect.tap((message) => feed.publish(Watch, message)),
        ),
      // A deletion is not published: a page following the room drops the message only when it
      // subscribes again. Publish one, in a `watch` of events, for pages to drop it at once.
      deleteMessage: ({ id }) =>
        Effect.flatMap(CurrentMember, (member) => store.remove(member.id, id)),
    };
  }),
  { authorize },
);

// A page's `watch`: the room's feed, from what came after the last message the page holds.
// Implemented on the binding's own `rpcs`, which provide `CurrentMember` per message, as an
// action's authentication does; the one authorization rule runs first, as it does for the
// actions. The feed keeps the subscription in the object's storage, so a message posted after
// the object hibernated still reaches the page. The rule runs as the page subscribes, not for
// each message: a member the room removed would go on receiving until their socket closes, so
// a room that removes members gives each member's `watch` a feed `key` of their own to `end`.
export const watch = RoomRpc.rpcs.toLayer(
  Effect.gen(function* () {
    const store = yield* MessageStore;
    const feed = yield* ActionDurableObject.Feed;
    const allowed = yield* authorize;

    return {
      watch: ({ after }, request) =>
        Stream.unwrap(
          Effect.as(allowed(), feed.subscribe(request, { initial: store.read(after) })),
        ),
    };
  }),
);

// The room's own API, for the Worker, read from the store the instance built.
export const calls = RoomCalls.toLayer(
  Effect.gen(function* () {
    const store = yield* MessageStore;

    return RoomCalls.of({
      latestAt: () => Effect.map(store.latest, (latest) => latest?.at ?? null),
    });
  }),
);
