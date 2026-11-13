import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Exit, Predicate, Queue, Scope, Stream } from "effect";

import { BoardRpc, Heard, Pinned, wires } from "../board.js";
import {
  clientOver,
  connected,
  evict,
  heldIn,
  objectOf,
  openHostOf,
  opened,
  reconnecting,
  stubs,
  watchingIn,
} from "../support/socket.js";
import { boards, following, notes, throughWorker } from "../support/watch.js";

const wire = (board: string, n: number) =>
  Effect.promise(
    async () =>
      await runInDurableObject(objectOf("Board", board), () => {
        const queue = wires.get(board);

        return queue !== undefined && Queue.offerUnsafe(queue, n);
      })
  );

describe("ActionClusterEntity's watches", () => {
  it.live(
    "answers an entity's polls at once where its events are not on Stored.layerEvents, its watch polling at nextPoll",
    () =>
      Effect.gen(function* () {
        const board = "unstored";
        const socket = yield* opened("Tally", board);
        const tally = yield* clientOver(BoardRpc, socket);
        const pins = yield* following(tally.watch(Pinned, { board }));

        yield* Effect.sleep("1 second");

        const before = yield* stubs;

        yield* Effect.sleep("3 seconds");

        const held = yield* heldIn("Tally", board);
        const after = yield* stubs;

        yield* tally.pin({ board, n: 4 });

        expect(yield* notes(pins, 1)).toStrictEqual([{ n: 4 }]);
        expect(held.map(({ parked }) => parked)).toStrictEqual([[]]);
        expect(
          after.started.invoke - before.started.invoke
        ).toBeGreaterThanOrEqual(2);
      }).pipe(Effect.scoped),
    { timeout: 60_000 }
  );

  it.live(
    "answers a parked poll with what a log's emit stream appended outside any handler, at the object's next settle",
    () =>
      Effect.gen(function* () {
        const board = "wired";
        const http = yield* boards;
        const socket = yield* opened("Board", board);

        const heard = yield* following(
          (yield* clientOver(BoardRpc, socket)).watch(Heard, { board })
        );

        yield* watchingIn("Board", board, 1);

        const offered = yield* wire(board, 5);

        yield* Effect.sleep("2 seconds");

        const unsettled = yield* Queue.clear(heard);

        yield* http.later({ board, n: 0, at: Date.now() + 3_600_000 });

        expect(offered).toBe(true);
        expect(unsettled).toStrictEqual([]);
        expect(yield* notes(heard, 1)).toStrictEqual([{ n: 5 }]);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );

  it.live(
    "lets a page whose socket a lost call closed with 1012 connect again and poll from its cursor, receiving each pin once",
    () =>
      Effect.gen(function* () {
        const board = "cut-resume";
        const http = yield* boards;

        yield* http.pin({ board, n: 1 });

        const scope = yield* Scope.make();

        const protocol = yield* Scope.provide(
          reconnecting("Board", board),
          scope
        );

        const received = yield* Queue.unbounded<number>();

        yield* (yield* clientOver(BoardRpc, { protocol }))
          .watch(Pinned, { board }, { cursor: "0" })
          .pipe(
            Stream.runForEach((item) =>
              item._tag === "Occurrence"
                ? Queue.offer(received, item.data.n)
                : Effect.void
            ),
            Effect.forkIn(scope)
          );

        const first = yield* Queue.take(received).pipe(
          Effect.timeout("20 seconds")
        );

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
        yield* watchingIn("Board", board, 1);
        yield* http.pin({ board, n: 2 });

        const second = yield* Queue.take(received).pipe(
          Effect.timeout("20 seconds")
        );

        yield* Effect.sleep("2 seconds");

        const extra = yield* Queue.clear(received);

        yield* Scope.close(scope, Exit.void);

        expect([first, second, extra]).toStrictEqual([1, 2, []]);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 90_000 }
  );

  it.live(
    "accepts an upgrade naming any version, or none, on a host made without protocol",
    () =>
      Effect.gen(function* () {
        const board = "open";

        const upgraded = (version: string) =>
          Effect.promise(
            async () =>
              await openHostOf("Board", board).fetch(
                `https://object/${version}`,
                {
                  headers: { upgrade: "websocket" },
                }
              )
          );

        const unversioned = yield* upgraded("");
        const versioned = yield* upgraded("?protocol=0");
        const socket = yield* connected(unversioned);

        yield* (yield* clientOver(BoardRpc, socket)).pin({ board, n: 3 });

        expect([unversioned.status, versioned.status]).toStrictEqual([
          101, 101,
        ]);
        expect(socket.closed).toStrictEqual([]);
        versioned.webSocket?.accept();
        versioned.webSocket?.close(1000);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );
});
