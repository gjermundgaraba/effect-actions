import { describe, expect, it } from "@effect/vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { Effect, Predicate, Queue, Schema, Stream } from "effect";
import { RpcClient } from "effect/rpc";

import { BoardRpc, Logged, Pinned } from "../board.js";
import { eventually } from "../support/eventually.js";
import {
  clientOver,
  evict,
  objectOf,
  opened,
  settledStubs,
  stubs,
  watchingIn,
} from "../support/socket.js";
import { boards, following, notes } from "../support/watch.js";
import { throughWorker } from "../support/worker.js";
import { Seer } from "../worker.js";

const SeerRpc = Seer.binding;

const Read = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.String),
});

describe("ActionClusterEntity's sockets", () => {
  it.live(
    "answers a check source's and a log source's parked polls after the object's eviction, with one stub call for the post, which sends no tells, and one for each parked poll",
    () =>
      Effect.gen(function* () {
        const board = "budget";
        const http = yield* boards;

        const checked = yield* opened("Board", board);
        const logged = yield* opened("Board", board);

        const pins = yield* following(
          (yield* clientOver(BoardRpc, checked)).watch(Pinned, { board })
        );

        const logs = yield* following(
          (yield* clientOver(BoardRpc, logged)).watch(Logged, { board })
        );

        yield* watchingIn("Board", board, 2);
        yield* evict("Board", board);

        const before = yield* settledStubs;

        yield* http.pin({ board, n: 7 });

        const pinned = yield* notes(pins, 1);
        const log = yield* notes(logs, 1);

        yield* watchingIn("Board", board, 2);
        yield* Effect.sleep("6 seconds");

        const after = yield* settledStubs;

        expect(pinned).toStrictEqual([{ n: 7 }]);
        expect(log).toStrictEqual([{ n: 7 }]);
        expect({
          invoke: after.started.invoke - before.started.invoke,
          hold: after.started.hold - before.started.hold,
          acknowledge: after.started.acknowledge - before.started.acknowledge,
        }).toStrictEqual({ invoke: 3, hold: 0, acknowledge: 0 });
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );

  it.live(
    "lets a watching socket's object hibernate, a new instance serving the next post while the socket stays open",
    () =>
      Effect.gen(function* () {
        const board = "idle";
        const http = yield* boards;
        const watching = yield* opened("Board", board);

        const pins = yield* following(
          (yield* clientOver(BoardRpc, watching)).watch(Pinned, { board })
        );

        yield* watchingIn("Board", board, 1);

        const before = (yield* stubs).instances.filter((instance) =>
          instance.includes(board)
        );

        yield* Effect.sleep("20 seconds");
        yield* http.pin({ board, n: 1 });

        const pinned = yield* notes(pins, 1);

        const after = (yield* stubs).instances.filter((instance) =>
          instance.includes(board)
        );

        expect(pinned).toStrictEqual([{ n: 1 }]);
        expect(after).toHaveLength(before.length + 1);
        expect(watching.socket.readyState).toBe(WebSocket.OPEN);
        expect(watching.closed).toStrictEqual([]);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );

  it.live(
    "authenticates a call by its upgrade's bearer token, across the object's eviction, a message's own header winning over the upgrade's",
    () =>
      Effect.gen(function* () {
        const room = "sockets";

        const socket = yield* opened("Seer", room, {
          authorization: "Bearer alice",
          "x-note": "upgrade",
        });

        const seer = yield* clientOver(SeerRpc, socket);

        const upgraded = yield* seer.readHeaders({ room });

        const overridden = yield* seer
          .readHeaders({ room })
          .pipe(RpcClient.withHeaders({ "x-note": "message" }));

        yield* evict("Seer", room);

        const evicted = yield* seer.readHeaders({ room });

        const unsigned = yield* opened("Seer", room);

        const refused = yield* Effect.flip(
          (yield* clientOver(SeerRpc, unsigned)).readHeaders({ room })
        );

        expect(upgraded.headers).toMatchObject({
          authorization: "Bearer alice",
          "x-note": "upgrade",
        });
        expect(overridden.headers).toMatchObject({
          authorization: "Bearer alice",
          "x-note": "message",
        });
        expect(evicted.headers).toMatchObject({
          authorization: "Bearer alice",
          "x-note": "upgrade",
        });
        expect(refused._tag).toBe("Unauthenticated");
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "hands a handler the same headers of one request over a socket as through ActionEntity.reaching, those ActionEntity.forwardedHeaders keeps",
    () =>
      Effect.gen(function* () {
        const room = "same-headers";

        const owned = {
          connection: "Upgrade",
          "content-type": "application/json",
          "sec-websocket-version": "13",
          "accept-language": "nb",
          "mcp-session-id": "session",
        };

        const kept = {
          authorization: "Bearer alice",
          cookie: "theme=dark",
          "x-note": "same",
        };

        const socket = yield* opened("Seer", room, { ...owned, ...kept });

        const overSocket = yield* (yield* clientOver(
          SeerRpc,
          socket
        )).readHeaders({ room });

        const reached = yield* Effect.promise(async () => {
          const response = await exports.default.fetch(
            "https://worker.example/api/readHeaders",
            {
              method: "POST",
              headers: { ...owned, ...kept },
              body: JSON.stringify({ room }),
            }
          );

          return await response.json();
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Read)));

        expect(overSocket.headers).toStrictEqual(reached.headers);
        expect(reached.headers).toStrictEqual(kept);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "resumes a watch from an old cursor, sending every pin past it once",
    () =>
      Effect.gen(function* () {
        const board = "resume";
        const http = yield* boards;

        yield* Effect.forEach([1, 2, 3], (n) => http.pin({ board, n }), {
          discard: true,
        });

        const watching = yield* opened("Board", board);

        const pins = yield* following(
          (yield* clientOver(BoardRpc, watching)).watch(
            Pinned,
            { board },
            { cursor: "1" }
          )
        );

        const resumed = yield* notes(pins, 2);

        yield* watchingIn("Board", board, 1);
        yield* Effect.sleep("3 seconds");

        expect(resumed).toStrictEqual([{ n: 2 }, { n: 3 }]);
        expect(yield* Queue.clear(pins)).toStrictEqual([]);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );

  it.live(
    "pushes an event a DeliverAt tell publishes from the object's alarm",
    () =>
      Effect.gen(function* () {
        const board = "alarm";
        const http = yield* boards;
        const watching = yield* opened("Board", board);

        const pins = yield* following(
          (yield* clientOver(BoardRpc, watching)).watch(Pinned, { board })
        );

        yield* watchingIn("Board", board, 1);
        yield* http.later({ board, n: 9, at: Date.now() + 60_000 });

        yield* Effect.promise(async () => {
          await runInDurableObject(objectOf("Board", board), (_, state) => {
            state.storage.sql.exec(
              "UPDATE cluster_messages SET deliver_at = ? WHERE processed = 0 AND deliver_at IS NOT NULL",
              Date.now()
            );
          });
          await runDurableObjectAlarm(objectOf("Board", board));
        });

        const pinned = yield* notes(pins, 1);

        expect(pinned).toStrictEqual([{ n: 9 }]);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );

  it.live(
    "sends nothing to a socket watching another board",
    () =>
      Effect.gen(function* () {
        const http = yield* boards;
        const onA = yield* opened("Board", "isolated-a");
        const onB = yield* opened("Board", "isolated-b");

        const fromA = yield* following(
          (yield* clientOver(BoardRpc, onA)).watch(Pinned, {
            board: "isolated-a",
          })
        );

        const fromB = yield* following(
          (yield* clientOver(BoardRpc, onB)).watch(Pinned, {
            board: "isolated-b",
          })
        );

        yield* watchingIn("Board", "isolated-a", 1);
        yield* watchingIn("Board", "isolated-b", 1);
        yield* http.pin({ board: "isolated-b", n: 2 });

        const pinned = yield* notes(fromB, 1);

        yield* Effect.sleep("3 seconds");

        const onAReceived = yield* Queue.clear(fromA);

        expect(pinned).toStrictEqual([{ n: 2 }]);
        expect(onAReceived).toStrictEqual([]);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );

  it.live(
    "closes a socket whose call an eviction cut off with 1012, as the next instance starts",
    () =>
      Effect.gen(function* () {
        const board = "lost";
        const socket = yield* opened("Board", board);

        yield* (yield* clientOver(BoardRpc, socket))
          .watch(Pinned, { board })
          .pipe(Stream.runDrain, Effect.forkScoped);

        yield* watchingIn("Board", board, 1);

        yield* Effect.promise(async () => {
          await runInDurableObject(objectOf("Board", board), (_, state) => {
            for (const held of state.getWebSockets()) {
              const attachment: unknown = held.deserializeAttachment();

              if (Predicate.isObject(attachment)) {
                held.serializeAttachment({ ...attachment, calls: ["cut"] });
              }
            }
          });
        });

        yield* evict("Board", board);
        yield* Effect.promise(async () => {
          await objectOf("Board", board).fetch("https://object/");
        });

        yield* Effect.sync(() => socket.closed).pipe(
          eventually((closed) => closed.length > 0)
        );

        expect(socket.closed[0]?.code).toBe(1012);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "refuses an upgrade naming another version, closing its socket with 4000",
    () =>
      Effect.gen(function* () {
        const socket = yield* opened("Board", "versions", {}, "0");

        yield* Effect.sync(() => socket.closed).pipe(
          eventually((closed) => closed.length > 0, "5 seconds")
        );

        expect(socket.closed).toStrictEqual([
          {
            code: 4000,
            reason: "This server speaks protocol 1: reload the page",
          },
        ]);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "closes a socket held across a deploy changing the version with 4000, its parked poll unanswered, and answers one the deploy kept",
    () =>
      Effect.forEach(
        [
          { served: "0", closed: [4000], pinned: [] },
          { served: "1", closed: [], pinned: [{ n: 3 }] },
        ],
        ({ served, closed, pinned }) =>
          Effect.gen(function* () {
            const board = `deployed-${served}`;
            const http = yield* boards;
            const socket = yield* opened("Board", board);

            const pins = yield* following(
              (yield* clientOver(BoardRpc, socket)).watch(Pinned, { board })
            );

            yield* watchingIn("Board", board, 1);
            yield* Effect.promise(async () => {
              await runInDurableObject(objectOf("Board", board), (_, state) => {
                for (const held of state.getWebSockets()) {
                  const attachment: unknown = held.deserializeAttachment();

                  if (Predicate.isObject(attachment)) {
                    held.serializeAttachment({
                      ...attachment,
                      version: served,
                    });
                  }
                }
              });
            });
            yield* evict("Board", board);
            yield* http.pin({ board, n: 3 });
            yield* Effect.sleep("3 seconds");

            expect([
              socket.closed.map(({ code }) => code),
              served,
            ]).toStrictEqual([closed, served]);
            expect([yield* Queue.clear(pins), served]).toStrictEqual([
              pinned,
              served,
            ]);
          }).pipe(Effect.scoped)
      ).pipe(Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );

  it.effect(
    "answers a request that is no upgrade 426, and an upgrade to an entity serving no sockets 404",
    () =>
      Effect.gen(function* () {
        const plain = yield* Effect.promise(
          async () =>
            await exports.default.fetch(
              "https://worker.example/sockets/Board/plain?protocol=1"
            )
        );

        const unserved = yield* Effect.promise(
          async () =>
            await objectOf("Nobody", "x").fetch("https://object/", {
              headers: { upgrade: "websocket" },
            })
        );

        expect([plain.status, unserved.status]).toStrictEqual([426, 404]);
      })
  );
});
