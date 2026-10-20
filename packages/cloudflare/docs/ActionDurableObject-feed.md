# ActionDurableObject's feed: push to a page

An object pushes what changes to the pages connected to it over their sockets, after it
hibernated too: a page calls an rpc that streams, its handler makes the call a **subscriber**
with `Feed`, and any part of the object publishes to it. A subscriber is kept in the object's
storage, keyed by its socket, so a value published by a new instance, after an eviction,
reaches the page that subscribed on the one before, as long as its socket stays open. The feed
is a push channel addressed by the call's request id, not a stream pipeline: a value published
goes to the socket as Effect's server would send it. An action answers once, so the stream is a
native rpc in the binding's `rpcs`, beside its actions (the core's `docs/ActionRpc.md`).

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
// a room that removes members closes their sockets, or gives each its own feed `key` to `end`.
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

- **One feed of many.** Give a subscriber a `key`, such as a topic or a document, and
  `publish(rpc, value, { key })` reaches only those given it.
- **End the streams.** `end(rpc, { key })` completes each subscriber's stream, its finalizers
  run, as when what it followed is gone.

## Follow from a page

The page runs the stream and observes its whole life: opened at its first value, each value,
then closed with the stream's `Exit`, after which it subscribes again from the last value it
holds:

```ts example=chat-rooms/src/browser.ts
import { Effect, type Exit, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import type { Message } from "./chat/Chat.js";
import { RoomRpc } from "./Rpc.js";

// Client module: what a web page imports. It holds the binding and nothing of the server.

// A subscription's life, as a page renders it: `opened` at its first message, each `message`,
// then `closed` with how the stream ended. The exit is the stream's own: a refusal, the socket
// dropping, an interruption, or a defect, such as a message the page cannot decode, which a page
// watching only for failures would never see, left showing a subscription that ended.
export interface Following<E> {
  readonly opened: Effect.Effect<void>;
  readonly message: (message: Message) => Effect.Effect<void>;
  readonly closed: (exit: Exit.Exit<void, E>) => Effect.Effect<void>;
}

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

    // The room's messages after `after`, then each as it is posted, told to `page` as they
    // arrive. It ends when the stream does, after `closed`, and never fails: what comes next is
    // the page's. Effect's socket client fails every stream it runs when its socket drops, so a
    // page subscribes again, after a backoff of its choosing, from the last message it holds; a
    // message posted as it subscribes may arrive twice, and a page drops an id it has seen.
    const follow = (
      after: number,
      page: Following<Stream.Error<ReturnType<typeof client.watch>>>,
    ) =>
      client.watch({ after }, { headers }).pipe(
        Stream.onFirst(() => page.opened),
        Stream.runForEach(page.message),
        Effect.exit,
        Effect.flatMap(page.closed),
      );

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

- **Opened at the first value.** Effect's client tells a page nothing when its subscription is
  kept, so a stream with nothing `initial` opens at its first published value.
- **Testing it.** `evictDurableObject(stub)` between a page subscribing and a post shows the
  value reach it from a new instance
  ([chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts)).
