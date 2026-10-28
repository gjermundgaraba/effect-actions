# ActionDurableObject: events

The core's events, the `Event` module, in a Durable Object: a page follows one over its socket, an agent over MCP. Read [ActionDurableObject.md](ActionDurableObject.md) first, and the core's `docs/Event.md` for check, current and log sources, `notify` and `publish`.

## Follow an event over a socket

List the event type in the rpcs' binding and its implementation beside the actions' in `ActionRpc.layer`, as `routes.ts` on [ActionDurableObject.md](ActionDurableObject.md) does, and a page watches it on its socket. `make` and `handlers` provide the object's own `Event.Events`, its logs kept in the object's storage, in place of the core's `Event.layerMemory`, so a handler announces with `notify` or `publish` as it does elsewhere. The room's messages are a check source over its store, which `postMessage` notifies after each post:

```ts example=chat-rooms/src/chat/events.ts
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Option, Schema } from "effect";

import { authorize } from "./authorize.js";
import { MessagePosted } from "./Chat.js";
import { MessageStore } from "./store.js";

const idOf = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt()))
);

const nextPoll = "30 seconds";

export const messageEvents = Event.implement(
  MessagePosted,
  Effect.gen(function* () {
    const store = yield* MessageStore;

    return {
      check: (_input, cursor) =>
        Effect.gen(function* () {
          const last = yield* store.last;

          const after = Option.filter(
            idOf(cursor),
            (id) => id >= 0 && id <= last
          );

          if (Option.isNone(after)) {
            return {
              cursor: String(last),
              events: [],
              truncated: cursor !== null,
              nextPoll,
            };
          }

          const messages = yield* store.read(after.value);

          return {
            cursor: String(messages.at(-1)?.id ?? after.value),
            events: messages.map((data) => ({
              eventId: String(data.id),
              data,
            })),
            nextPoll,
          };
        }),
    };
  }),
  { authorize }
);
```

The page reads, then watches from the last id it read: `messages` in [chat-rooms/src/browser.ts](../examples/chat-rooms/src/browser.ts). The object keeps each socket's subscription in its storage while it hibernates and resumes it from the position it reached when it next wakes, on any event, authenticating it again from the headers it was made with: a token that expired meanwhile ends the watch with `Unauthenticated`. What a check, current and log source do in an object is on `ActionDurableObject.handlers`; which calls the object keeps across hibernation, on `ActionDurableObject.layerWebSocket`. To empty an object, `ctx.storage.deleteAll()` deletes its subscriptions, webhook subscriptions and alarm times with the rest: close its sockets as it does, so their pages connect again and watch anew.

## Announce a change another object makes

An object's `Event.Events` is its own: `notify` and `publish` reach the subscribers of the object they run in, and no other, so every surface serving an event, a socket's rpcs, MCP or an HTTP watch, is among that object's `routes`, and a Worker's own routes serve actions alone. A change another object makes reaches them through a call, a plain `RpcGroup` on this object's stub, whose handler notifies. chat-rooms' lobby is one object, which pages follow for every room's preview: a room's `lobby` task sends the lobby's `roomChanged` the room's latest activity after each post, deletion and expiry ([chat-rooms/src/platform/lobby-stubs.ts](../examples/chat-rooms/src/platform/lobby-stubs.ts)), and the lobby records it and notifies:

```ts example=chat-rooms/src/lobby/handlers.ts
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { LobbyCalls } from "./Calls.js";
import { LobbyHost } from "./host.js";
import { Previews, PreviewsChanged } from "./Lobby.js";
import { PreviewStore } from "./store.js";

export const lobby = Action.implement(
  Previews,
  Effect.map(
    LobbyHost,
    (host) => () => Effect.map(host.previews, (previews) => ({ previews }))
  )
);

export const calls = LobbyCalls.toLayer(
  Effect.gen(function* () {
    const store = yield* PreviewStore;
    const events = yield* Event.Events;

    return LobbyCalls.of({
      roomChanged: ({ room, latestAt }) =>
        Effect.flatMap(store.record(room, latestAt), (changed) =>
          changed ? events.notify(PreviewsChanged) : Effect.void
        ),
      previews: () => store.read,
    });
  })
);
```

The lobby's event is a whole value, every room's preview in each occurrence, so it has a current source, whose revisions the object keeps in its storage: a page is sent the previews as they are, then again after each notify, and watches with no read before it, `followLobby` in [chat-rooms/src/browser.ts](../examples/chat-rooms/src/browser.ts):

```ts example=chat-rooms/src/lobby/events.ts
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { PreviewsChanged } from "./Lobby.js";
import { PreviewStore } from "./store.js";

export const previewEvents = Event.implement(
  PreviewsChanged,
  Effect.map(PreviewStore, (store) => ({
    current: () => Effect.map(store.read, (previews) => ({ previews })),
  }))
);
```

## Serve the actions and events over MCP

An object can serve `ActionMcp.layerHttp` among its routes, but an agent then needs one connection per object. chat-rooms serves its MCP endpoint from the Worker instead, every room's actions and `MessagePosted` reaching the room the input names: [ActionDurableObject-placement.md](ActionDurableObject-placement.md). The core's `docs/ActionMcp.md` says what each method answers; in an object:

- A held request keeps the object in memory, billed for its duration, until it ends: an `events/stream`, and a `subscriptions/listen`, the stream an MCP 2026-07-28 client holds open for list changes and resource updates, which `layerHttp` allows wherever it serves events. Its `allowSubscriptions: false` serves events by poll alone.
- An agent polling with `events/poll` lets the object hibernate only if it asks less often than the runtime's idle window, 10 seconds: a check source answers `nextPoll`, 30 seconds in `events.ts` above, and the agent reads on from its cursor on whichever instance answers.
- A poll reads the source each time; a stream reads it as `ActionDurableObject.handlers` says.
- A client of a 2025 revision opens a session, which lives in the instance: once it is evicted, the session's next request is answered 404, at which the MCP specification has the client open a new one. Events are the 2026-07-28 revision's alone, which keeps no session.
- A tool call is answered once its result is ready, so a reset of the object before then fails the request itself, which the client sees. A tool reporting progress is answered by a stream that opens with its first progress: a reset cuts the stream off with no answer, which a client may take for a call still running, so give such a client a timeout.

## Deliver an event by webhook

Provide `layerWebhooks` to an object's MCP endpoint, or to its `ActionHttp.layer`, with an `HttpClient` for the deliveries, such as fetch's, and an agent that holds no request subscribes a callback with `events/subscribe`. It is the core's `Webhook.layer`, described in its `docs/Webhook.md`, kept in the object's storage and restored as the object builds after an eviction, with each wait of 10 seconds or more, a retry's backoff or a subscription's expiry, ended by the object's alarm, so the object hibernates between deliveries. The event's authentication needs `principal` and `schema`, given to `Authentication.make`: a delivery restored after an eviction runs as the subscriber its `schema` kept. What a callback's address check is in an object is on `ActionDurableObject.layerWebhooks`. A Worker serving an object's events through a placement cannot deliver them: nothing in it outlives a request. A test answers the object's deliveries with Miniflare's `outboundService`, given to `@cloudflare/vitest-plugin`'s `miniflare` options.
