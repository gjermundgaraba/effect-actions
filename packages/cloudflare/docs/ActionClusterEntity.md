# ActionClusterEntity

Import `@gjermundgaraba/effect-actions-cloudflare/ActionClusterEntity`. A page that follows an entity's events from a browser holds one WebSocket to that entity's Durable Object, which the Workers runtime keeps open while the object sleeps, or **hibernates**: the object is evicted from memory, and a message on the socket builds it again. `ActionClusterEntity.make(options)` returns the class the Worker exports as `ClusterEntity`, in place of `@effect/platform-cloudflare`'s own: it extends that class, so every entity of the cluster runs on it as before, and it serves Effect RPC over such sockets for the entities named in `sockets`. Each call on a socket is forwarded into the object's own entity through `Entity.client`, so the entity authenticates and answers it as it does a call from the Worker. `make`'s JSDoc holds the rules.

## Export the class

The Worker's module exports `ClusterEntity = ActionClusterEntity.make({ initialize, sockets: [Room], protocol })` beside Effect's three other classes, and its default export, `ActionCluster.handler`, hands a page's upgrade at `/rooms/<room>/rpc` to the room's object, `getByName(CloudflareCluster.encodeName(Room.type, room)).fetch(request)` in the `ClusterEntity` namespace, before the router: [`chat-rooms/src/worker.ts`](../examples/chat-rooms/src/worker.ts), shown whole in [ActionCluster.md](ActionCluster.md). `initialize` is the function `CloudflareDurableObjects.setInitializer` returned for `ActionCluster.initializer`, the one that builds the application. The binding and migration in `wrangler.jsonc` are unchanged: the class keeps the name `ClusterEntity`.

`protocol` names the version of the rpcs the page was built against. A page names it in its socket's URL, `?protocol=1`, and an upgrade naming another is accepted and closed at once with `protocol.code`, a code from 4000 to 4999, so a page left open across a deploy that changed the rpcs stops and asks to be reloaded, instead of sending calls the new server reads differently:

```ts example=chat-rooms/src/Rpc.ts
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

import { MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";

export const RoomRpc = ActionRpc.make([...Messages, MessagePosted], {
  authentication: Login,
});

export const protocolVersion = "1";

export const unsupportedProtocol = 4000;
```

## Follow a room from a page

A page connects with `RpcClient.layerProtocolSocket`, whose `retryPolicy`, `ActionRpc.reconnectUntil(unsupportedProtocol)`, connects again after a drop but stops at the refusal, and watches through `ActionRpc.client(RoomRpc)` with `mode: "poll"`: a watch is then a sequence of polls, each a unary call the host forwards and answers, never a stream held open by the object. A page cannot set a browser `WebSocket`'s headers, only the browser's own cookies and `Origin` go with the upgrade, so the page puts its token on each message, through `RpcClient.CurrentHeaders`; the host lays a message's headers over the upgrade's, those `ActionEntity.forwardedHeaders` keeps, the message's winning. The page's actions stay on the JSON routes, `openRoom`:

```ts example=chat-rooms/src/browser.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Layer, Predicate, Stream } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { RoomHttp } from "./Api.js";
import { MessagePosted } from "./chat/Chat.js";
import type { DemoRoomName } from "./chat/Chat.js";
import { protocolVersion, RoomRpc, unsupportedProtocol } from "./Rpc.js";

export const overSocket = RpcClient.layerProtocolSocket({
  retryPolicy: ActionRpc.reconnectUntil(unsupportedProtocol),
}).pipe(Layer.provide(RpcSerialization.layerJson));

export const roomConnection = (baseUrl: string, room: DemoRoomName) => {
  const url = new URL(`/rooms/${room}/rpc`, baseUrl);

  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("protocol", protocolVersion);

  return overSocket.pipe(
    Layer.provide(Socket.layerWebSocket(url.href)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal)
  );
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

export const followRoom = (room: DemoRoomName, token: string) =>
  Effect.map(
    ActionRpc.client(RoomRpc),
    (client) => (after: number) =>
      client
        .watch(MessagePosted, { room }, { cursor: String(after), mode: "poll" })
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

The host keeps no state in memory between messages but the calls it is forwarding, which a page's interrupt or the socket's close interrupts. Each socket's attachment, which the runtime keeps with the socket across hibernation, holds the upgrade's headers, the calls under way and the **parked** polls: a poll whose answer had nothing new is kept there instead of answered, and asked again once the object's events changed, read through `Stored.layerEvents`' change signal each time a handler on the object ends, whether a call, a tell or the alarm ran it. Only a poll whose page is `notified`, `ActionRpc.Page`'s field, is parked: a check source not `notified` has each poll answered at once, its page polling at `nextPoll`. A change no handler writes to a `notified` source reaches a parked poll only when the page sends it again, `ActionRpc.pollResentAfter`, 4 minutes, after it sent it; `make`'s gotchas say which changes those are. So an entity serving sockets keeps its events on `Stored.layerEvents`, as the example's room does in [`chat-rooms/src/routes.ts`](../examples/chat-rooms/src/routes.ts); one keeping them elsewhere has every poll answered at once, its pages polling at `nextPoll`.

## What a post costs

A post a socket watches, by a handler that sends no calls or tells, costs **1 + P** Durable Object stub calls, `invoke` each, measured on the example's room with two pages watching it, where it is 3:

- **1**, the post itself, the Worker's call into the room;
- **P**, the parked polls on that object, each asked again once, by the host, through the room's own `Entity.client`, which the runtime sends as a stub call to the object itself.

No `hold` or `acknowledge` is called: a poll is unary. A page's next poll after an answer reaches the object as a socket message, not a stub call, and is parked at once when nothing changed since the answer and the answer's call was under 30 seconds earlier; later it is sent to the entity, one stub call, which renews a subscription hook's lease. A page watching over HTTP adds no P. The example's test of these counts, "costs each post 1 + P stub calls", runs the Worker through [`chat-rooms/test/worker.ts`](../examples/chat-rooms/test/worker.ts), which exports a `ClusterEntity` counting each `invoke` by object and tag.

## Test on workerd

[`chat-rooms/test/worker.test.ts`](../examples/chat-rooms/test/worker.test.ts) opens a page's socket through the Worker's own `fetch`, with an `upgrade: websocket` header, and passes the response's `webSocket` to `Socket.fromWebSocket` under the browser module's `overSocket`, closing it when the scope ends: a socket left open keeps its attachment, and a later test of the object reads it. `evictDurableObject` evicts the room while the page's socket stays open, as hibernation does.
