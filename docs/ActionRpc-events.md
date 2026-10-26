# Events over rpcs

An [event type](Event.md) in an RPC binding is a stream rpc named after it, taking
`{ input, cursor }`, which pushes each occurrence as the server reads it. A client's
`watch(event, input, options)` holds it open over the client's protocol, a socket or HTTP, as
`Action.client`'s does, and connects again after a drop, resuming from the last occurrence it
delivered. Experimental, as [events](Event.md) are.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error,
search [ActionRpc-failures.md](ActionRpc-failures.md). For one symbol,
`grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`.

## Bind and serve events

List the event types in `ActionRpc.make` beside the actions, and their implementations in
`ActionRpc.layer`'s list ([ActionRpc.md](ActionRpc.md#serve-the-rpcs)); live-rpc's binding
holds `MessagePosted` beside its actions. The same implementations serve HTTP and MCP too:
[build-events/src/routes.ts](../examples/build-events/src/routes.ts) serves them all three ways,
and says which serialization a watch needs over HTTP.

```ts example=build-events/src/Rpc.ts
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import {
  BuildFinished,
  FinishBuild,
  PipelineStatus,
  StartBuild,
  TailLog,
} from "./builds/Builds.js";
import { DeployRequested, RequestDeploy } from "./deploys/Deploys.js";
import { Login } from "./identity/Identity.js";

// The RPC binding: each action an rpc named after it, and each event a stream rpc named after
// it, which pushes each occurrence as the server reads it. Plain data, as the HTTP binding is.
export const Rpc = ActionRpc.make(
  [FinishBuild, StartBuild, TailLog, BuildFinished, PipelineStatus, RequestDeploy, DeployRequested],
  { authentication: Login },
);
```

What a stream rpc sends is on `ActionRpc.layer`; what a watch fails with, and when it
reconnects, on `ActionRpc.client`.

## Follow what a request names

A watch runs the layer's `middleware` and its authentication as it starts, and again each time it
connects, so its source
reads the same request-time services an action's handler does. live-rpc's room travels in a
header, which `ResolveRoom` turns into `CurrentRoom` ([ActionRpc.md](ActionRpc.md#send-request-context-with-a-call)):
the event's check reads that room's messages, and its `key` is the room, so `postMessage`'s
notify for one room wakes that room's pages alone.

```ts example=live-rpc/src/chat/events.ts
import { Effect, Option, Schema } from "effect";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { authorize } from "./authorize.js";
import { MessagePosted } from "./Chat.js";
import { CurrentRoom } from "./room.js";
import { MessageStore } from "./store.js";

const idOf = Schema.decodeUnknownOption(Schema.NumberFromString.pipe(Schema.check(Schema.isInt())));

// A cursor this source gives is `<epoch>:<id>`, the store's epoch and the id of the last message
// a page holds, so one from before a restart of the memory store is told apart. A page starting
// a watch gives the id alone, as `readMessages`' `after` is, which is the store's now.
const positionOf = (epoch: string, cursor: string | null) => {
  const parts = cursor?.includes(":") === true ? cursor.split(":") : [epoch, cursor];

  return parts.length === 2 && parts[0] === epoch ? idOf(parts[1]) : Option.none();
};

// The room's messages as an event, read from the store that keeps them: a check source.
// `postMessage` notifies after each post, so a page receives it at once, not at its next read
// every 5 seconds.
export const messageEvents = Event.implement(
  MessagePosted,
  Effect.gen(function* () {
    const store = yield* MessageStore;

    return {
      check: (_input, cursor) =>
        Effect.gen(function* () {
          const room = yield* CurrentRoom;
          const last = yield* store.last(room);

          const after = Option.filter(
            positionOf(store.epoch, cursor),
            (id) => id >= 0 && id <= last,
          );

          // No cursor starts after the room's last message. One this room never gave, such as
          // one from before a restart, is answered `truncated` from there: the page learns its
          // messages may be another run's, and reads the room again with `readMessages`.
          if (Option.isNone(after)) {
            return { cursor: `${store.epoch}:${last}`, events: [], truncated: cursor !== null };
          }

          const messages = yield* store.read(room, after.value);

          return {
            cursor: `${store.epoch}:${messages.at(-1)?.id ?? after.value}`,
            // A message's id counts within its room and the store's epoch, so the event's id
            // names all three: a watch drops an id it has seen, and after a restart of the memory
            // store `lobby:1` is another message.
            events: messages.map((data) => ({
              eventId: `${store.epoch}:${room}:${data.id}`,
              data,
            })),
          };
        }),
      // A notify for one room wakes that room's pages alone: the key is the room the watch's
      // header names, read as `check` reads it.
      key: () => CurrentRoom,
    };
  }),
  { authorize },
);
```

The page sends the room and its token with the watch: `RpcClient.withHeaders` wraps an Effect,
so `browser.ts`'s `messages` sets them around the stream, and so on every request it sends again
after a drop ([live-rpc/src/browser.ts](../examples/live-rpc/src/browser.ts)).

- **No poll.** An rpc client holds the stream open; a client that cannot, such as a serverless
  function, watches over [HTTP](ActionHttp.md#serve-and-watch-events) or MCP.
- **Which deployment.** A notify wakes the watches its process holds, so the process serving the
  sockets is the one whose `Event.Events` the handlers notify; another process's watches read
  the post at their next read, 5 seconds on. A log source fed by `emit` and a `subscription` hook
  need a server that outlives a request, as over MCP.
