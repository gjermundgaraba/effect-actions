import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Predicate, Schedule } from "effect";

import { Pinned } from "../board.js";
import {
  answeredEarlier,
  heldIn,
  objectOf,
  pollOf,
  raw,
  settledStubs,
  until,
} from "../support/socket.js";
import { boards, throughWorker } from "../support/watch.js";

const parkedIn = (board: string, count: number) =>
  heldIn("Board", board).pipe(
    Effect.repeat({
      until: (held) =>
        held.length === 1 &&
        held.every(
          ({ calls, parked }) => calls.length === 0 && parked.length === count
        ),
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout("20 seconds")
  );

const parkedAs = (board: string, id: string) =>
  heldIn("Board", board).pipe(
    Effect.repeat({
      until: (held) =>
        held.some(({ parked }) =>
          parked.some(
            (entry) => Predicate.isObject(entry) && entry["id"] === id
          )
        ),
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout("20 seconds")
  );

describe("ActionClusterEntity's polls", () => {
  it.live(
    "parks a page's next poll with no call within 30 seconds of its watch's last call, and forwards one sent later to the entity",
    () =>
      Effect.gen(function* () {
        const board = "lease";
        const { socket, received } = yield* raw("Board", board);
        const poll = pollOf(socket, Pinned.name, board);
        const fresh = crypto.randomUUID();
        const stale = crypto.randomUUID();

        poll("0", crypto.randomUUID(), null);

        yield* until(
          () => received,
          (messages) => messages.length >= 1
        );

        poll("1", fresh, null);
        poll("2", stale, null);

        yield* until(
          () => received,
          (messages) => messages.length >= 3
        );

        yield* answeredEarlier("Board", board, stale, 30_000);

        const before = yield* settledStubs;

        poll("3", fresh, "0");
        poll("4", stale, "0");

        yield* parkedIn(board, 2);

        const after = yield* settledStubs;

        expect(received).toHaveLength(3);
        expect(after.started.invoke - before.started.invoke).toBe(1);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "answers a change a check source's upstream holds when the page sends its poll again, not when the object settles, and never the parked poll the page interrupted",
    () =>
      Effect.gen(function* () {
        const board = "upstream";
        const http = yield* boards;
        const { socket, received } = yield* raw("Board", board);
        const poll = pollOf(socket, Pinned.name, board);
        const watch = crypto.randomUUID();

        poll("0", crypto.randomUUID(), null);

        yield* until(
          () => received,
          (messages) => messages.length >= 1
        );

        poll("1", watch, null);

        yield* until(
          () => received,
          (messages) => messages.length >= 2
        );

        poll("2", watch, "0");

        yield* parkedIn(board, 1);

        yield* Effect.promise(async () => {
          await runInDurableObject(objectOf("Board", board), (_, state) => {
            state.storage.sql.exec("INSERT INTO board_notes (n) VALUES (8)");
          });
        });

        yield* http.later({ board, n: 0, at: Date.now() + 3_600_000 });
        yield* settledStubs;
        yield* Effect.sleep("2 seconds");

        const settled = received.length;

        socket.send(JSON.stringify({ _tag: "Interrupt", requestId: "2" }));
        poll("3", watch, "0");

        yield* until(
          () => received,
          (messages) => messages.length >= 3
        );

        poll("4", watch, "1");
        yield* parkedAs(board, "4");
        yield* http.pin({ board, n: 9 });

        yield* until(
          () => received,
          (messages) => messages.length >= 4
        );

        yield* settledStubs;
        yield* Effect.sleep("1 second");

        expect(
          received.filter((message) => message.includes('"requestId":"2"'))
        ).toStrictEqual([]);
        expect(settled).toBe(2);
        expect(received[2]).toContain('"requestId":"3"');
        expect(received[2]).toContain('"data":{"n":8}');
        expect(received[3]).toContain('"requestId":"4"');
        expect(received[3]).toContain('"data":{"n":9}');
        expect(received).toHaveLength(4);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );
});
