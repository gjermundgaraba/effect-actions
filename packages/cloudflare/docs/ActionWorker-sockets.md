# ActionWorker sockets

A page that follows an entity's events from a browser holds one WebSocket to that entity's Durable Object, which the Workers runtime keeps open while the object sleeps, or **hibernates**: the object is evicted from memory, and a message on the socket builds it again. An entity given a `socket` in `ActionWorker.make`'s `entities` accepts such sockets: the Worker hands a page's upgrade at the socket's `path` to the entity's object, `getByName(CloudflareCluster.encodeName(type, id))` in the `ClusterEntity` namespace, without waiting on the application, and the class `make` returns as `ClusterEntity` serves Effect RPC over it, forwarding each call into the object's own entity through `Entity.client`, so the entity authenticates and answers it as it does a call from the Worker. `ActionWorker.Socket`'s JSDoc holds the rules; [ActionWorker.md](ActionWorker.md) shows the example's whole Worker, its room's socket at `/rooms/<room>/rpc`.

## Name the version a page speaks

A socket's `actions` lists the contracts of the entity it serves, here those of the page's own binding, `RoomSocket`, so the page and the socket name one list. Its `protocol` names the version of the rpcs the page was built against, and changes with them, and with the socket's `actions`. A page names it in its socket's URL, `?protocol=2`, and an upgrade naming another is accepted and closed at once with `protocol.code`, a code from 4000 to 4999, so a page left open across a deploy that changed the rpcs stops and asks to be reloaded, instead of sending calls the new server reads differently:

```ts example=chat-rooms/src/Rpc.ts
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

import { MessagePosted } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

export const RoomSocket = ActionRpc.make([MessagePosted], {
  authentication: Login,
});

export const protocolVersion = "2";

export const unsupportedProtocol = 4000;
```

## Follow a room from a page

A page connects with `ActionRpc.socketClient(RoomSocket, { url, watchMode: "poll" })`, which connects again after a drop but stops at the refusal's code, as at any from 4000 to 4999, and watches by poll: a watch is then a sequence of polls, each a unary call the host forwards and answers, never a stream held open by the object. A page cannot set a browser `WebSocket`'s headers, only the browser's own cookies and `Origin` go with the upgrade, so the page puts its token on each message, through `RpcClient.CurrentHeaders`; the host lays a message's headers over the upgrade's, those `ActionEntity.forwardedHeaders` keeps, the message's winning. The page's actions stay on the JSON routes, `openRoom`:

```ts example=chat-rooms/src/browser.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Predicate, Stream } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient } from "effect/rpc";

import { RoomHttp } from "./Api.js";
import { MessagePosted } from "./chat/Chat.js";
import type { DemoRoomName } from "./chat/Chat.js";
import { protocolVersion, RoomSocket } from "./Rpc.js";

export const roomSocket = (
  baseUrl: string,
  room: DemoRoomName
): ActionRpc.SocketTarget => {
  const url = new URL(`/rooms/${room}/rpc`, baseUrl);

  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("protocol", protocolVersion);

  return { url: url.href };
};

export const openRoom = (baseUrl: string, room: DemoRoomName, token: string) =>
  Effect.gen(function* () {
    const client = yield* ActionHttp.client(RoomHttp, {
      baseUrl,
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.bearerToken(token)
      ),
    });

    return {
      read: (after: number) =>
        Effect.map(
          client.readMessages({ room, after }),
          ({ messages }) => messages
        ),
      post: (text: string) =>
        Effect.flatMap(
          Effect.sync(() => crypto.randomUUID()),
          (request) =>
            client.postMessage({ room, text, request }).pipe(
              Effect.retry({
                while: (error) =>
                  Predicate.isTagged(error, "HttpClientError") &&
                  error.reason._tag === "TransportError",
                times: 2,
              })
            )
        ),
    };
  });

export const followRoom = (
  socket: ActionRpc.SocketTarget,
  room: DemoRoomName,
  token: string
) =>
  Effect.map(
    ActionRpc.socketClient(RoomSocket, { ...socket, watchMode: "poll" }),
    (client) => (after: number) =>
      client
        .watch(MessagePosted, { room }, { cursor: String(after) })
        .pipe(
          Stream.updateService(
            RpcClient.CurrentHeaders,
            Headers.merge(
              Headers.fromInput({ authorization: `Bearer ${token}` })
            )
          )
        )
  );
```

## What the socket holds

The host keeps no state in memory between messages but the calls it is forwarding, which a page's interrupt or the socket's close interrupts. Each socket's attachment, which the runtime keeps with the socket across hibernation, holds the upgrade's headers, the calls under way and the **parked** polls: a poll whose answer had nothing new is kept there instead of answered, and asked again once the object's events changed, read through `Stored.layerEvents`' change signal as `Stored.layerEvents` appends to a log or `notify`s a source in the object, through the `Stored.ChangeListener` that `ActionCluster.layer` gives each entity's build, so work a handler forked into the entity's scope that outlives its call wakes them too, and again each time a handler on the object ends, whether a call, a tell or the alarm ran it. Only a poll whose page is `notified`, `ActionRpc.Page`'s field, is parked: a check source not `notified` has each poll answered at once, its page polling at `nextPoll`. A change no handler writes to a `notified` source reaches a parked poll only when the page sends it again, `ActionRpc.pollResentAfter`, 4 minutes, after it sent it; `ActionWorker.Socket`'s gotchas say which changes those are. So an entity serving sockets keeps its events on `Stored.layerEvents`, as the example's room does in [`chat-rooms/src/routes.ts`](../examples/chat-rooms/src/routes.ts); one keeping them elsewhere has every poll answered at once, its pages polling at `nextPoll`.

## What a post costs

A post a socket watches, by a handler that sends no calls or tells, costs **1 + P** Durable Object stub calls, `invoke` each, measured on the example's room with two pages watching it, where it is 3:

- **1**, the post itself, the Worker's call into the room;
- **P**, the parked polls on that object, each asked again once, by the host, through the room's own `Entity.client`, which the runtime sends as a stub call to the object itself, as the post's first change is made; a poll asked before a later change of the same post and finding nothing new is asked again, one more call.

The P is paid by any handler, or any work it forked, that appends to any of the object's logs or `notify`s any of its sources, not only a post to the event a page watches: the host reads one change signal for all of them.

No `hold` or `acknowledge` is called: a poll is unary. A page's next poll after an answer reaches the object as a socket message, not a stub call, and is parked at once when nothing changed since the answer and the answer's call was under 30 seconds earlier; later it is sent to the entity, one stub call, which renews a subscription hook's lease. A page watching over HTTP adds no P. The example's test of these counts, "costs each post 1 + P stub calls", runs the Worker through [`chat-rooms/test/worker.ts`](../examples/chat-rooms/test/worker.ts), which exports a `ClusterEntity` counting each `invoke` by object and tag.

## Test on workerd

[`chat-rooms/test/worker.test.ts`](../examples/chat-rooms/test/worker.test.ts) opens a page's socket through the Worker's own `fetch`, with an `upgrade: websocket` header, and passes the response's `webSocket` to `Socket.fromWebSocket`, the `socket` the browser module's `followRoom` connects with, closing it when the scope ends: a socket left open keeps its attachment, and a later test of the object reads it. `evictDurableObject` evicts the room while the page's socket stays open, as hibernation does.
