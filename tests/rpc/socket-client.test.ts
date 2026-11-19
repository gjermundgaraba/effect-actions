import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import {
  RpcClientError,
  RpcMiddleware,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";

import * as Event from "../../src/contract/Event.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { makeMessages, Posted, texts } from "../support/events.js";

class Recorded extends RpcMiddleware.Service<Recorded>()(
  "effect-actions/test/Recorded"
) {}

const Feed = ActionRpc.make([Posted]);

const serving = (
  log: ReturnType<typeof makeMessages>,
  tags: string[],
  serialization = RpcSerialization.layerJson
) =>
  HttpRouter.serve(
    ActionRpc.layer(Feed, [log.implementation], {
      middleware: [Recorded],
    }).pipe(
      Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
      Layer.provide(serialization),
      Layer.provide(Event.layerMemory),
      Layer.provide(
        Layer.succeed(Recorded)((effect, { rpc }) =>
          Effect.andThen(
            Effect.sync(() => tags.push(rpc._tag)),
            effect
          )
        )
      )
    ),
    { disableLogger: true, disableListenLog: true }
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

const closed = (code: number) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) });

const closingWith = (code: number) => {
  let opened = 0;

  const socket = Socket.make({
    reader: Effect.sync(() => {
      opened += 1;

      return {
        pull: Effect.andThen(
          Effect.sleep("1 millis"),
          Effect.fail(closed(code))
        ),
        upgrade: () => Effect.void,
      };
    }),
    writer: Effect.succeed({
      write: () => Effect.void,
      writeAll: () => Effect.void,
    }),
  });

  return { socket, opened: () => opened };
};

const watchedUntilClosed = (code: number) =>
  Effect.gen(function* () {
    const { socket, opened } = closingWith(code);

    const client = yield* ActionRpc.socketClient(Feed, { socket });

    const fiber = yield* Effect.forkChild(
      Stream.runDrain(client.watch(Posted, {}))
    );

    yield* TestClock.adjust("10 minutes");

    return { exit: fiber.pollUnsafe(), opened: opened() };
  }).pipe(Effect.scoped);

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

describe("ActionRpc.socketClient", () => {
  it.live(
    "holds one socket for every watch, polls first under watchMode poll, and runs its hooks",
    () =>
      Effect.gen(function* () {
        const log = makeMessages();
        const tags: string[] = [];
        let sockets = 0;
        const hooks: string[] = [];

        const received = yield* HttpServer.addressFormattedWith((address) =>
          Effect.gen(function* () {
            const client = yield* ActionRpc.socketClient(Feed, {
              url: `${address.replace(/^http/u, "ws")}/rpc`,
              webSocket: (url) => {
                sockets += 1;

                return new globalThis.WebSocket(url);
              },
              watchMode: "poll",
              hooks: {
                onConnect: Effect.sync(() => hooks.push("connect")),
                onDisconnect: Effect.sync(() => hooks.push("disconnect")),
              },
            });

            const watched = (channel: string) =>
              client
                .watch(Posted, { channel }, { cursor: "0" })
                .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

            log.post("general", "one");
            log.post("random", "two");

            const general = yield* watched("general");
            const random = yield* watched("random");

            return [
              ...(yield* Fiber.join(general)),
              ...(yield* Fiber.join(random)),
            ];
          }).pipe(Effect.scoped)
        ).pipe(Effect.provide(serving(log, tags)));

        expect(texts(received)).toStrictEqual(["one", "two"]);
        expect(sockets).toBe(1);
        expect(new Set(tags)).toStrictEqual(
          new Set([ActionRpc.pollTag(Posted.name)])
        );
        expect(hooks).toStrictEqual(["connect", "disconnect"]);
      })
  );

  it.live("writes its messages with the serialization it is given", () =>
    Effect.gen(function* () {
      const log = makeMessages();

      log.post("general", "one");

      const received = yield* HttpServer.addressFormattedWith((address) =>
        Effect.gen(function* () {
          const client = yield* ActionRpc.socketClient(Feed, {
            url: `${address.replace(/^http/u, "ws")}/rpc`,
            serialization: RpcSerialization.ndjson,
          });

          return yield* client
            .watch(Posted, {}, { cursor: "0" })
            .pipe(Stream.take(1), Stream.runCollect);
        }).pipe(Effect.scoped, Effect.timeout("5 seconds"))
      ).pipe(Effect.provide(serving(log, [], RpcSerialization.layerNdjson)));

      expect(texts(received)).toStrictEqual(["one"]);
    })
  );

  it.effect(
    "stops at a close with an application code, failing with that close, its socket opened once",
    () =>
      Effect.gen(function* () {
        const { exit, opened } = yield* watchedUntilClosed(4321);

        const error =
          exit !== undefined && Exit.isFailure(exit)
            ? Cause.squash(exit.cause)
            : undefined;

        expect(isRpcClientError(error) && error.reason).toMatchObject({
          _tag: "SocketCloseError",
          code: 4321,
        });
        expect(opened).toBe(1);
      })
  );

  it.effect("connects again after a close with a code below 4000", () =>
    Effect.gen(function* () {
      const { exit, opened } = yield* watchedUntilClosed(1001);

      expect(exit).toBeUndefined();
      expect(opened).toBeGreaterThan(1);
    })
  );
});
