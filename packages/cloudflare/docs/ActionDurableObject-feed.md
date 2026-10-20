# ActionDurableObject's feed: push to a page

An object pushes what changes to the pages connected to it over their sockets, after it
hibernated too: a page calls an rpc that streams, its handler makes the call a **subscriber**
with `Feed`, and any part of the object publishes to it. A subscriber is kept in the object's
storage, keyed by its socket, so a value published by a new instance, after an eviction,
reaches the page that subscribed on the one before, as long as its socket stays open. The
records sit beside the application's own data, so `storage.deleteAll()` drops them too, and
every subscriber with them: `end` the feed before wiping the object's storage. An
action answers once, so the stream is a native rpc in the binding's `rpcs`, beside its actions
(the core's `docs/ActionRpc.md`).

`Feed`'s rules and traps are on `ActionDurableObject.Feed`. This page uses the chat-rooms
example, whose pages follow a room's messages.

## Declare an rpc that streams

Make it with `stream: true` and its own schemas, `Watch` in
[chat-rooms/src/chat/Chat.ts](../examples/chat-rooms/src/chat/Chat.ts), and give it to the
binding's `rpcs`. Under the binding's `authentication`, each message authenticates as a protected
action's does:

```ts example=chat-rooms/src/Rpc.ts
import { RpcGroup } from "effect/rpc";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Messages, Preview, Watch } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

// A room's rpcs, on the socket a page keeps open to its object: its actions, and `watch`, which
// streams. Plain data: the object and a browser page both import it.
export const RoomRpc = ActionRpc.make([Preview, ...Messages], {
  authentication: Login,
  rpcs: RpcGroup.make(Watch),
});
```

## Subscribe, and publish

The handler returns `feed.subscribe(request)`, given its second argument, with what the page
missed as `initial`; the action posting a message publishes it to the rpc. `Feed` is a startup
service, so both yield it as they yield a store:

```ts example=chat-rooms/src/chat/handlers.ts
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
// the object hibernated still reaches the page.
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
```

The handlers are the host's, implemented on the binding's own `rpcs`, which provide the
identity, and `ActionRpc.layer` requires them: `routes.ts` provides them to it
([ActionDurableObject.md](ActionDurableObject.md#serve-rpcs-over-hibernating-websockets)).
A native rpc runs no action's `authorize`, so the handler runs the same rule itself, first.

- **One feed of many.** Give a subscriber a `key`, such as a topic or a document, and
  `publish(rpc, value, { key })` reaches only those given it.
- **End the streams.** `end(rpc, { key })` completes each subscriber's stream, as when what it
  followed is gone.

## Follow from a page

The page runs the stream and renders each value. Effect's socket client fails every stream it
runs when its socket drops, so the page subscribes again from the last value it holds, and
drops a value it already has:

```ts example=chat-rooms/src/browser.ts
import { Effect, Layer, Predicate, Schedule, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import type { Message } from "./chat/Chat.js";
import { RoomRpc } from "./Rpc.js";

// Client module: what a web page imports. It holds the binding and nothing of the server.

// Effect's own client protocol, one WebSocket to a room's object, speaking JSON: the socket's
// URL is `wss://<host>/rooms/<room>/rpc`. The layer owns the socket, so provide it once, around
// the page's whole program; a page provides `Socket.layerWebSocketConstructorGlobal`, the
// browser's own WebSocket. The client pings every five seconds and the object's runtime
// answers, so a page left open does not wake the object.
export const connection = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(RpcSerialization.layerJson),
  );

// A room as a page uses it. A browser WebSocket sets no header when it connects, so the token
// travels on each message; a client that can set headers on the upgrade, such as a Worker or a
// native app, sends it once there, and the socket keeps it.
export const openRoom = (token: string) =>
  Effect.gen(function* () {
    const client = yield* ActionRpc.client(RoomRpc);
    const headers = { authorization: `Bearer ${token}` };
    const signedIn = RpcClient.withHeaders(headers);

    // The room's messages after `after`, then each as it is posted, rendered in order. Effect's
    // socket client fails every stream it runs when its socket drops, so this subscribes again,
    // a second later, from the last message rendered; a refusal ends it. A message posted as the
    // page subscribes may arrive twice, and is rendered once.
    const follow = (after: number, render: (message: Message) => Effect.Effect<void>) =>
      Effect.suspend(() => {
        let lastSeen = after;

        return Effect.suspend(() =>
          client.watch({ after: lastSeen }, { headers }).pipe(
            Stream.filter((message) => message.id > lastSeen),
            Stream.runForEach((message) => {
              lastSeen = message.id;

              return render(message);
            }),
          ),
        ).pipe(
          Effect.retry({
            while: (error) => Predicate.isTagged(error, "RpcClientError"),
            schedule: Schedule.spaced("1 second"),
          }),
        );
      });

    return {
      preview: Effect.map(client.preview(), ({ latestAt }) => latestAt),
      follow,
      post: (text: string) => client.postMessage({ text }).pipe(signedIn),
      remove: (id: number) =>
        client.deleteMessage({ id }).pipe(
          signedIn,
          Effect.as("removed" as const),
          Effect.catchTags({
            MessageNotFound: () => Effect.succeed("removed" as const),
            NotAuthor: () => Effect.succeed("not-yours" as const),
          }),
        ),
    };
  });
```

- **What a page may see twice.** A value published while the handler reads `initial` may reach
  the page twice, in `initial` and as published: a value carries an id, such as a message's,
  and the page skips one it has seen.
- **What wakes the object.** Effect's client acknowledges every chunk it is sent, and each
  acknowledgement wakes a hibernating object, as a call does.
- **Testing it.** `evictDurableObject(stub)` between a page subscribing and a post shows the
  value reach it from a new instance
  ([chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts)); under celld,
  `CELLD_IDLE_EVICT_S` sets the idle seconds after which it evicts an object.
