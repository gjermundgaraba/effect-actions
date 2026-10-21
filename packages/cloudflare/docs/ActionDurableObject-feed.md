# ActionDurableObject's feed: push to a page across hibernation

An object pushes what changes to the pages connected to it over their sockets, after it
hibernated too. The core's `Feed`, from `@gjermundgaraba/effect-actions/Feed`, is the service:
a page calls an rpc that streams, its handler makes the call a **subscriber**, and any part of
the object publishes to it; the core's `docs/Feed.md` teaches it. An object's is
`ActionDurableObject.layerFeed`, which `make` and `handlers` provide: a subscriber is kept in the
object's storage, keyed by its socket, so a value published by a new instance, after an
eviction, reaches the page that subscribed on the one before, as long as its socket stays open.
It is a push channel addressed by the call's request id, not a stream pipeline: a value
published goes to the socket as Effect's server would send it. Domain code yields the core's
`Feed` and imports nothing of this package, whichever feed the entrypoint provides.

The rules every feed keeps are on the core's `Feed`, and what an object's adds, its storage, its
one socket path and wiping it, on `ActionDurableObject.layerFeed`. This page uses the chat-rooms
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

// The version of these rpcs a page was built with, which it names in its socket's URL, and the
// close code a room answers a page naming another with: raise the version when a change would
// break a page still open from before a deployment.
export const protocolVersion = "1";

export const unsupportedProtocol = 4000;
```

## Subscribe, and publish

The handler returns `feed.subscribe(request)`, given its second argument, with what the page
missed as `initial`; the action posting a message publishes it to the rpc. `Feed` is a startup
service, so both yield the core's as they yield a store:

```ts example=chat-rooms/src/chat/handlers.ts
import { Effect, Stream } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Feed from "@gjermundgaraba/effect-actions/Feed";
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
    const feed = yield* Feed.Feed;

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
    const feed = yield* Feed.Feed;
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

What a `key` reaches and what `end` completes are the core's `Feed`'s rules; what this feed
adds, wiping the object's storage among them, is on `ActionDurableObject.layerFeed`.

## Follow from a page

The page runs the stream and observes its whole life: opened at its first value, each value,
then closed with the stream's `Exit`, after which it subscribes again from the last value it
holds:

```ts example=chat-rooms/src/browser.ts
import { Effect, type Exit, Layer, Predicate, Schedule, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import type { Message } from "./chat/Chat.js";
import { protocolVersion, RoomRpc, unsupportedProtocol } from "./Rpc.js";

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

// When the client connects again after its socket closes: Effect's own default, a backoff of at
// most five seconds, for good, except after a room refused the page's version, which it would
// refuse at every attempt, each one waking its object.
export const reconnect = Schedule.min([
  Schedule.exponential("500 millis", 1.5),
  Schedule.spaced("5 seconds"),
]).pipe(
  Schedule.setInputType<Socket.SocketError>(),
  Schedule.while(
    ({ input }) =>
      !(
        Predicate.isTagged(input.reason, "SocketCloseError") &&
        input.reason.code === unsupportedProtocol
      ),
  ),
);

// Effect's own client protocol, one WebSocket to a room's object, speaking JSON: the socket's
// URL is `wss://<host>/rooms/<room>/rpc`, given the version of the rpcs the page was built
// with. A room serving another closes the socket at once with `unsupportedProtocol`, which
// fails every call and stream with a `SocketCloseError` of that code, and stops the client:
// show "reload". The layer owns the socket, so provide it once, around the page's whole
// program; a page provides `Socket.layerWebSocketConstructorGlobal`, the browser's own
// WebSocket. The client pings every five seconds and the object's runtime answers, so a page
// left open does not wake the object.
export const connection = (url: string) =>
  RpcClient.layerProtocolSocket({ retryPolicy: reconnect }).pipe(
    Layer.provide(Socket.layerWebSocket(`${url}?protocol=${protocolVersion}`)),
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

- **Opened at the first value.** A page learns its subscription is live at its first value, as
  the core's Feed page says.
- **Testing it.** `evictDurableObject(stub)` between a page subscribing and a post shows the
  value reach it from a new instance
  ([chat-rooms/test/worker.test.ts](../examples/chat-rooms/test/worker.test.ts)).
