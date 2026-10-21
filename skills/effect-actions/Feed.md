# Feed

A server pushes values to the clients following it: a client calls an rpc that streams, its
handler makes the call a **subscriber** with `Feed`, and any part of the server **publishes** a
value to the rpc's subscribers, or to those of one **key**, such as a room. The feed is a
service any handler, store or job yields, and an implementation is a Layer the entrypoint
chooses: `Feed.layer` keeps the subscribers in the memory of one process, which holds their
connections, as a Node server does; on Cloudflare, `ActionDurableObject.layerFeed`, in
`@gjermundgaraba/effect-actions-cloudflare`, keeps them in a Durable Object's storage, so they
outlive its hibernation. Domain code depends on `Feed` alone, whichever is provided.

Import `@gjermundgaraba/effect-actions/Feed` as `Feed`: the service is `Feed.Feed`. A message the library throws says its fix; for a
compiler diagnostic or Effect's own error, search [Feed-failures.md](Feed-failures.md). The rules
every feed keeps are on `Feed.Feed`, and what the in-memory one adds on `Feed.layer`: grep the
symbol. This page follows live-rpc, whose pages follow a room's messages.

## Declare an rpc that streams

An action answers once, so the stream is a native rpc in the binding's `rpcs`, beside the
actions: `Watch` in [live-rpc/src/chat/Chat.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/chat/Chat.ts), made
with `stream: true` and its own schemas, given to the binding in
[live-rpc/src/Rpc.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/Rpc.ts)
([ActionRpc.md](ActionRpc.md#bind-actions-to-rpcs)). Under the binding's `authentication` each
message authenticates as a protected action's does; the binding's `middleware` reaches actions
alone, so `Watch`'s group adds the room's middleware itself.

## Subscribe, and publish

The handler returns `feed.subscribe(request)`, given its second argument, with what the client
missed as `initial` and the room as its `key`; the action posting a message publishes it to the
rpc and the room. `Feed` is a startup service, so both yield it as they yield a store:

```ts example=live-rpc/src/chat/handlers.ts
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
```

- **The stream is the call's.** A value goes to the client as it is published, so transform it
  before publishing: an operator on the stream `subscribe` returns may see none of the values.
- **One feed of many.** A subscriber has one `key`, or none: `publish(rpc, value, { key })`
  reaches only those given it, and a publish without a key every subscriber of the rpc.
- **End the streams.** `end(rpc, { key })` completes each subscriber's stream, its finalizers
  run, as when a member leaves a room; `end()` completes every subscriber's. Access is checked
  as the call subscribes, so a member removed is followed until their `watch` ends.
- **Provide one feed.** [live-rpc/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/routes.ts) provides the
  handler to the binding's layer, and [server.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/server.ts) provides
  `Feed.layer` once, beside the store, around routes that both publish and subscribe.

## Follow from a page

The page runs the stream and observes its whole life, natively: `Stream.onFirst` for opened,
each value, then `Effect.exit` for how it ended. Effect's socket client fails every stream it
runs when its socket drops and connects again by itself, so the page subscribes again after a
`Schedule` backoff, from the last value it holds, which `initial` sends on, and stops on a
typed refusal: `follow` in [live-rpc/src/browser.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/browser.ts).

- **Opened at the first value.** A page learns its subscription is live at its first value:
  Effect's chunk is a non-empty array and its protocol has no "subscribed" frame. An rpc whose
  page must know at once streams a first value, such as a snapshot that may be an empty list.
- **Repeats.** A value published as the page subscribes may arrive beside `initial` and again in
  it: give values an id the page drops repeats by.

## Test it

Provide `Feed.layer` to the routes as any service, beside the store: `Testing.layer` provides
none. It serves rpcs over `RpcServer.layerProtocolHttp`, where a stream answers under
`RpcSerialization.layerNdjson`, as `Testing.layer` says
([live-rpc/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/test/routes.test.ts)). A dropped socket and
the page's resubscription need a real one
([live-rpc/test/server.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/test/server.test.ts)).
