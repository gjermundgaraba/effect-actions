import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Queue, Ref } from "effect";
import * as Feed from "@gjermundgaraba/effect-actions/Feed";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { Socket } from "effect/socket";
import { connection, openChat } from "../src/browser.js";
import type { Message } from "../src/chat/Chat.js";
import { connect } from "../src/page.js";
import { MessageStore } from "../src/chat/store.js";
import { rpc } from "../src/routes.js";

// What the socket adds, which no in-memory test reaches: the upgrade, the page's `connect(url)`
// and the bound on a message. The rpcs are served as server.ts serves them, over a WebSocket
// at `/rpc` on Node's HTTP server, on port 0: the system picks a free one, so tests run side
// by side. The server closes with the test's scope.
const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);

// server.ts allows 64 KiB. A bound this small is passed by a message the contract accepts.
const maxPayload = 256;

const listening = HttpRouter.serve(socket, { disableLogger: true, disableListenLog: true }).pipe(
  // `provideMerge` keeps `HttpServer` for the test, which reads the port from it.
  Layer.provideMerge(
    NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0, websocket: { maxPayload } }),
  ),
  Layer.provide([MessageStore.layerMemory, Feed.layer]),
);

// The page's client, on Node's global `WebSocket`. Each test closes it with `Effect.scoped`,
// before the server stops: a server that is stopping waits for its open sockets.
const chat = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const url = HttpServer.formatAddress(server.address).replace("http", "ws");

  return yield* Effect.acquireRelease(
    Effect.sync(() => connect(`${url}/rpc`)),
    (page) => Effect.promise(() => page.close()),
  );
});

describe("the chat, over a WebSocket", () => {
  it.effect("answers the page's client on a listening port, each call as its token names", () =>
    Effect.gen(function* () {
      const page = yield* chat;

      const posted = yield* Effect.promise(() =>
        page.room("lobby", "ada").post("Deploying at noon."),
      );

      expect(posted).toEqual({ id: 1, author: "ada", text: "Deploying at noon." });
      expect(yield* Effect.promise(() => page.room("lobby", "grace").read(0))).toEqual({
        access: "member",
        messages: [posted],
      });
    }).pipe(Effect.scoped, Effect.provide(listening)),
  );

  it.effect("closes the socket on a message over the bound, failing the call that sent it", () =>
    Effect.gen(function* () {
      const page = yield* chat;
      const ada = page.room("lobby", "ada");

      yield* Effect.promise(() => ada.post("Short."));

      // 400 characters are a text the contract accepts and a message over 256 bytes. The server
      // reads none of it: it closes the socket with 1009, "message too big", and the call fails
      // with Effect's `RpcClientError`, its reason the socket's close, which no action declares.
      yield* Effect.promise(() =>
        expect(ada.post("x".repeat(400))).rejects.toMatchObject({ reason: { code: 1009 } }),
      );
    }).pipe(Effect.scoped, Effect.provide(listening)),
  );

  // Effect's socket client connects again by itself after its socket drops, failing the streams
  // it ran: `follow` subscribes again, from the last message the page holds. Real time, as the
  // client's reconnection and the page's backoff wait on it.
  it.live("follows a room across a dropped socket, from the last message the page holds", () =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const url = `${HttpServer.formatAddress(server.address).replace("http", "ws")}/rpc`;
      const sockets: Array<WebSocket> = [];

      const constructor = Layer.succeed(Socket.WebSocketConstructor)((address) => {
        const socket = new globalThis.WebSocket(address);

        sockets.push(socket);

        return socket;
      });

      const page = yield* Layer.build(connection(url).pipe(Layer.provide(constructor)));
      const follower = yield* Effect.provideContext(openChat, page);
      const ada = follower.room("lobby", "ada");
      const before = yield* ada.post("Before the drop.");
      const received = yield* Queue.unbounded<Message>();
      const opened = yield* Ref.make(0);
      const resubscribed = yield* Deferred.make<void>();

      yield* Effect.forkScoped(
        ada.follow(0, {
          opened: Ref.updateAndGet(opened, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 2 ? Deferred.succeed(resubscribed, undefined) : Effect.void,
            ),
          ),
          message: (message) => Queue.offer(received, message),
          closed: () => Effect.void,
        }),
      );

      expect(yield* Queue.take(received)).toEqual(before);

      for (const socket of sockets) socket.close();

      const writer = yield* chat;
      const after = yield* Effect.promise(() => writer.room("lobby", "grace").post("After it."));

      expect(yield* Queue.take(received)).toEqual(after);

      yield* Deferred.await(resubscribed);

      expect(sockets.length).toBeGreaterThan(1);
    }).pipe(Effect.scoped, Effect.provide(listening)),
  );
});
