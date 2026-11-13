# ActionClusterEntity

Import `@gjermundgaraba/effect-actions-cloudflare/ActionClusterEntity`. A page that follows an entity's events from a browser holds one WebSocket to that entity's Durable Object, which the Workers runtime keeps open while the object sleeps, or **hibernates**: the object is evicted from memory, and a message on the socket builds it again. `ActionClusterEntity.make(options)` returns the class the Worker exports as `ClusterEntity`, in place of `@effect/platform-cloudflare`'s own: it runs the same entity program, `makeClusterEntityProgram`, so every entity of the cluster runs on it as before, and it serves Effect RPC over such sockets for the entities named in `sockets`. Each call on a socket is forwarded into the object's own entity through `Entity.client`, so the entity authenticates and answers it as it does a call from the Worker. `make`'s JSDoc holds the rules.

## Export the class

The Worker's module exports `ClusterEntity = ActionClusterEntity.make({ initialize, sockets: [Room], protocol })` beside Effect's three other classes, and its `fetch` hands a page's upgrade at `/rooms/<room>/rpc` to the room's object, `env.CLUSTER_ENTITY.getByName(CloudflareCluster.encodeName(Room.type, room)).fetch(request)`, before the router: [`chat-rooms/src/worker.ts`](../examples/chat-rooms/src/worker.ts), shown whole in [ActionCluster.md](ActionCluster.md). `initialize` is the function `CloudflareDurableObjects.setInitializer` returned, the one that builds the application. The binding and migration in `wrangler.jsonc` are unchanged: the class keeps the name `ClusterEntity`.

`protocol` names the version of the rpcs the page was built against. A page names it in its socket's URL, `?protocol=1`, and an upgrade naming another is accepted and closed at once with `protocol.code`, a code from 4000 to 4999, so a page left open across a deploy that changed the rpcs stops and asks to be reloaded, instead of sending calls the new server reads differently:

```ts example=chat-rooms/src/Rpc.ts
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

import { MessagePosted, Messages } from "./chat/Chat.js";
import { Login } from "./identity/Identity.js";
import { Previews, PreviewsChanged } from "./lobby/Lobby.js";

export const RoomRpc = ActionRpc.make([...Messages, MessagePosted], {
  authentication: Login,
});

export const LobbyRpc = ActionRpc.make([Previews, PreviewsChanged]);

export const protocolVersion = "1";

export const unsupportedProtocol = 4000;
```

## Follow a room from a page

A page connects with `RpcClient.layerProtocolSocket`, whose `retryPolicy`, `ActionRpc.reconnectUntil(unsupportedProtocol)`, connects again after a drop but stops at the refusal, and calls through `ActionRpc.client(RoomRpc, { delivery: "poll" })`: a watch is then a sequence of polls, each a unary call the host forwards and answers, never a stream held open by the object. A page cannot set a browser `WebSocket`'s headers, only the browser's own cookies and `Origin` go with the upgrade, so the page puts its token on each message, through `RpcClient.CurrentHeaders`; the host lays a message's headers over the upgrade's, the message's winning. The page's actions stay on the JSON routes, `openRoom`:

```ts example=chat-rooms/src/browser.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Layer, Predicate, Stream } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { LobbyHttp, RoomHttp } from "./Api.js";
import { MessagePosted } from "./chat/Chat.js";
import type { DemoRoomName } from "./chat/Chat.js";
import { PreviewsChanged } from "./lobby/Lobby.js";
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
                while: (error) => Predicate.isTagged(error, "HttpClientError"),
                times: 2,
              })
            )
        ),
      remove: (id: number) =>
        client.deleteMessage({ room, id }).pipe(
          Effect.as("removed" as const),
          Effect.catchTags({
            MessageNotFound: () => Effect.succeed("removed" as const),
            NotAuthor: () => Effect.succeed("not-yours" as const),
          })
        ),
    };
  });

export const followRoom = (room: DemoRoomName, token: string) =>
  Effect.map(
    ActionRpc.client(RoomRpc, { delivery: "poll" }),
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

export const followLobby = (baseUrl: string) =>
  Effect.map(ActionHttp.client(LobbyHttp, { baseUrl }), (client) =>
    client.watch(PreviewsChanged, {}).pipe(
      Stream.filter((received) => Predicate.isTagged(received, "Occurrence")),
      Stream.map(({ data }) => data.previews)
    )
  );
```

## What the socket holds

The host keeps no state in memory between messages. Each socket's attachment, which the runtime keeps with the socket across hibernation, holds the upgrade's headers, the calls under way and the **parked** polls: a poll whose answer had nothing new is kept there instead of answered, and asked again once the object's events changed, read through `Stored.layerEvents`' change signal each time a call, the alarm, or a handler's work on the object settles. So an entity serving sockets keeps its events on `Stored.layerEvents`, as the example's room does in [`chat-rooms/src/routes.ts`](../examples/chat-rooms/src/routes.ts); one keeping them elsewhere has every poll answered at once, its pages polling at `nextPoll`.

## What a post costs

Every call into an entity object, from the Worker, from another object or from the object itself, is one Durable Object stub call, `invoke`. A post a socket watches costs **1 + T + P** stub calls, measured on the example's room with two pages watching it:

- **1**, the post itself, the Worker's call into the room;
- **T**, the follow-up tells the post's handler sends: 2 for every post in the example, the room's persisted tell to itself, `tellLobby`, and the lobby's `roomChanged` that tell sends, plus 1 more, the room's `expire` tell to itself, for the first post of an hour's window;
- **P**, the parked polls on that object, each asked again once, by the host, through the room's own `Entity.client`.

No `hold` or `acknowledge` is called: a poll is unary. A page's next poll after an answer reaches the object as a socket message, not a stub call, and is parked at once when nothing changed since the answer. An application that sends no tells has T = 0; the lobby, watched over HTTP, adds no P.

## Test on workerd

[`chat-rooms/test/worker.test.ts`](../examples/chat-rooms/test/worker.test.ts) opens a page's socket through the Worker's own `fetch`, with an `upgrade: websocket` header, and passes the response's `webSocket` to `Socket.fromWebSocket` under the browser module's `overSocket`, closing it when the scope ends: a socket left open keeps its attachment, and a later test of the object reads it. `evictDurableObject` evicts the room while the page's socket stays open, as hibernation does.
