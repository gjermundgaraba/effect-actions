import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Deferred, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { MessageStore } from "../src/chat/store.js";
import { connect } from "../src/page.js";
import { rpc } from "../src/routes.js";

const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson)
);

const maxPayload = 256;

const listening = HttpRouter.serve(socket, {
  disableLogger: true,
  disableListenLog: true,
}).pipe(
  Layer.provideMerge(
    NodeHttpServer.layer(createServer, {
      host: "127.0.0.1",
      port: 0,
      websocket: { maxPayload },
    })
  ),
  Layer.provide([MessageStore.layerMemory, Event.layerMemory])
);

const chat = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const url = HttpServer.formatAddress(server.address).replace("http", "ws");

  return yield* Effect.acquireRelease(
    Effect.sync(() => connect(`${url}/rpc`)),
    (page) =>
      Effect.promise(async () => {
        await page.close();
      })
  );
});

describe("the chat, over a WebSocket", () => {
  it.effect(
    "answers the page's client on a listening port, each call as its token names",
    () =>
      Effect.gen(function* () {
        const page = yield* chat;

        const posted = yield* Effect.promise(
          async () => await page.room("lobby", "ada").post("Deploying at noon.")
        );

        expect(posted).toStrictEqual({
          id: 1,
          author: "ada",
          text: "Deploying at noon.",
        });
        expect(
          yield* Effect.promise(
            async () => await page.room("lobby", "grace").read(0)
          )
        ).toStrictEqual({
          access: "member",
          messages: [posted],
        });
      }).pipe(Effect.scoped, Effect.provide(listening))
  );

  it.effect(
    "delivers a post to a page watching the room on the same socket, until it stops",
    () =>
      Effect.gen(function* () {
        const page = yield* chat;
        const received = yield* Deferred.make<string>();
        const stopped = yield* Deferred.make<string>();

        const stop = page.room("lobby", "grace").watch(
          0,
          (message) => {
            if (message._tag === "Occurrence") {
              Deferred.doneUnsafe(received, Effect.succeed(message.data.text));
            }
          },
          (why) => {
            Deferred.doneUnsafe(stopped, Effect.succeed(why));
          }
        );

        yield* Effect.promise(
          async () => await page.room("lobby", "ada").post("Deploying at noon.")
        );

        expect(yield* Deferred.await(received)).toBe("Deploying at noon.");

        stop();

        expect(yield* Deferred.await(stopped)).toBe("stopped");
      }).pipe(Effect.scoped, Effect.provide(listening))
  );

  it.effect(
    "closes the socket on a message over the bound, failing the call that sent it",
    () =>
      Effect.gen(function* () {
        const page = yield* chat;
        const ada = page.room("lobby", "ada");

        yield* Effect.promise(async () => await ada.post("Short."));

        yield* Effect.promise(async () => {
          await expect(ada.post("x".repeat(400))).rejects.toMatchObject({
            reason: { code: 1009 },
          });
        });
      }).pipe(Effect.scoped, Effect.provide(listening))
  );
});
