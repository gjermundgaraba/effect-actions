import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { RpcSerialization, RpcServer } from "effect/rpc";
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
  Layer.provide([MessageStore.layerMemory, Event.layerMemory]),
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

  it.effect("delivers a post to a page watching the room on the same socket, until it stops", () =>
    Effect.gen(function* () {
      const page = yield* chat;
      const received = yield* Deferred.make<string>();
      const stopped = yield* Deferred.make<string>();

      // From the room's start, id 0, so the post reaches it however soon after the watch it is
      // sent.
      const stop = page.room("lobby", "grace").watch(
        0,
        (message) => {
          if (message._tag === "Occurrence")
            Deferred.doneUnsafe(received, Effect.succeed(message.data.text));
        },
        (why) => Deferred.doneUnsafe(stopped, Effect.succeed(why)),
      );

      yield* Effect.promise(() => page.room("lobby", "ada").post("Deploying at noon."));

      expect(yield* Deferred.await(received)).toBe("Deploying at noon.");

      stop();

      expect(yield* Deferred.await(stopped)).toBe("stopped");
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
});
