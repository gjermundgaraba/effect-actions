import { describe, expect, it } from "@effect/vitest";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Stored from "@gjermundgaraba/effect-actions/Stored";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Predicate } from "effect";

import { BoardRpc, Pinned, Polled } from "../board.js";
import { eventually } from "../support/eventually.js";
import {
  answeredEarlier,
  clientOver,
  heldIn,
  objectOf,
  opened,
  pollOf,
  raw,
  settledStubs,
  until,
} from "../support/socket.js";
import { boards, following, notes } from "../support/watch.js";
import { throughWorker } from "../support/worker.js";

const parkedIn = (board: string, count: number) =>
  heldIn("Board", board).pipe(
    eventually(
      (held) =>
        held.length === 1 &&
        held.every(
          ({ calls, parked }) => calls.length === 0 && parked.length === count
        ),
      "20 seconds"
    )
  );

const parkedAs = (board: string, id: string) =>
  heldIn("Board", board).pipe(
    eventually(
      (held) =>
        held.some(({ parked }) =>
          parked.some(
            (entry) => Predicate.isObject(entry) && entry["id"] === id
          )
        ),
      "20 seconds"
    )
  );

const signalIn = (board: string) =>
  Effect.promise(
    async () =>
      await runInDurableObject(objectOf("Board", board), (_, state) => {
        try {
          return state.storage.sql.exec(Stored.changeSignal).one()["signal"];
        } catch (error) {
          return error instanceof Error ? error.message : "thrown";
        }
      })
  );

const drift = (type: string, id: string) =>
  Effect.promise(async () => {
    await runInDurableObject(objectOf(type, id), (_, state) => {
      for (const [table, column] of [
        ["effect_actions_event_revision", "name"],
        ["effect_actions_event_position", "event"],
      ] as const) {
        state.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
        state.storage.sql.exec(`CREATE TABLE ${table} (${column} TEXT)`);
      }
    });
  });

describe("ActionClusterEntity's polls", () => {
  it.live(
    "reads Stored.changeSignal from an object's SQLite, which fails with no such table before the entity first activates, then moves with each pin",
    () =>
      Effect.gen(function* () {
        const board = "signal";
        const http = yield* boards;

        const before = yield* signalIn(board);

        yield* http.pin({ board, n: 1 });

        const once = yield* signalIn(board);

        yield* http.pin({ board, n: 2 });

        const twice = yield* signalIn(board);

        expect(before).toContain("no such table");
        expect(once).toBeTypeOf("number");
        expect(twice).toBeTypeOf("number");
        expect(twice).not.toBe(once);
      }).pipe(Effect.provide(throughWorker)),
    { timeout: 30_000 }
  );

  it.live(
    "answers a poll with a defect when the change signal fails for another reason than a missing table, as on a database whose tables drifted",
    () =>
      Effect.gen(function* () {
        const room = "drifted";

        yield* drift("Tally", room);

        const { socket, received } = yield* raw("Tally", room);

        pollOf(socket, Pinned.name, room)("0", crypto.randomUUID(), null);

        yield* until(
          () => received,
          (messages) => messages.length >= 1
        );

        expect(received[0]).toContain("no such column");
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "answers a parked poll with a defect when the change signal fails as the object settles",
    () =>
      Effect.gen(function* () {
        const board = "drifted-parked";
        const { socket, received } = yield* raw("Board", board);
        const poll = pollOf(socket, Pinned.name, board);

        poll("1", crypto.randomUUID(), null);

        yield* until(
          () => received,
          (messages) => messages.length >= 1
        );

        poll("2", crypto.randomUUID(), "0");
        yield* parkedAs(board, "2");
        yield* drift("Board", board);
        socket.send(JSON.stringify({ _tag: "Eof" }));

        yield* until(
          () => received,
          (messages) => messages.length >= 2
        );

        expect(received[1]).toContain('"requestId":"2"');
        expect(received[1]).toContain("no such column");
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "answers a page's next poll with a defect when the change signal fails, and the other calls of its message as before",
    () =>
      Effect.gen(function* () {
        const board = "drifted-next";
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

        yield* drift("Board", board);

        socket.send(
          JSON.stringify([
            {
              _tag: "Request",
              id: "2",
              tag: ActionRpc.pollTag(Pinned.name),
              payload: { input: { board }, cursor: "0", watch },
              headers: [],
            },
            {
              _tag: "Request",
              id: "3",
              tag: "later",
              payload: { board, n: 0, at: Date.now() + 3_600_000 },
              headers: [],
            },
          ])
        );

        yield* until(
          () => received,
          (messages) => messages.length >= 4
        );

        const answers = received.slice(2);

        expect(
          answers.find((message) => message.includes('"requestId":"2"'))
        ).toContain("no such column");
        expect(
          answers.find((message) => message.includes('"requestId":"3"'))
        ).toContain('"_tag":"Success"');
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

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
    "answers each change to a check source that is not notified within its nextPoll, though no handler moved the change signal",
    () =>
      Effect.gen(function* () {
        const board = "unnotified";
        const http = yield* boards;
        const socket = yield* opened("Board", board);

        yield* http.pin({ board, n: 1 });

        const pins = yield* following(
          (yield* clientOver(BoardRpc, socket)).watch(
            Polled,
            { board },
            { cursor: "0" }
          )
        );

        const first = yield* notes(pins, 1);

        const unnotified = (n: number) =>
          Effect.andThen(
            Effect.promise(async () => {
              await runInDurableObject(objectOf("Board", board), (_, state) => {
                state.storage.sql.exec(
                  "INSERT INTO board_notes (n) VALUES (?)",
                  n
                );
              });
            }),
            notes(pins, 1).pipe(Effect.timeout("5 seconds"))
          );

        const eight = yield* unnotified(8);
        const nine = yield* unnotified(9);

        expect([first, eight, nine]).toStrictEqual([
          [{ n: 1 }],
          [{ n: 8 }],
          [{ n: 9 }],
        ]);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );

  it.live(
    "asks a parked poll again when work a handler forked past its call pins, before the page sends the poll again",
    () =>
      Effect.gen(function* () {
        const board = "forked";
        const http = yield* boards;
        const socket = yield* opened("Board", board);

        const pins = yield* following(
          (yield* clientOver(BoardRpc, socket)).watch(Pinned, { board })
        );

        yield* parkedIn(board, 1);
        yield* http.soon({ board, n: 7 });

        expect(
          yield* notes(pins, 1).pipe(Effect.timeout("10 seconds"))
        ).toStrictEqual([{ n: 7 }]);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );

  it.live(
    "never answers a parked poll the page interrupted, and answers the poll sent after it once the change signal moves",
    () =>
      Effect.gen(function* () {
        const board = "interrupted";
        const http = yield* boards;
        const { socket, received } = yield* raw("Board", board);
        const poll = pollOf(socket, Pinned.name, board);
        const watch = crypto.randomUUID();

        poll("1", watch, null);

        yield* until(
          () => received,
          (messages) => messages.length >= 1
        );

        poll("2", watch, "0");
        yield* parkedAs(board, "2");

        socket.send(JSON.stringify({ _tag: "Interrupt", requestId: "2" }));
        poll("3", watch, "0");
        yield* parkedAs(board, "3");
        yield* http.pin({ board, n: 9 });

        yield* until(
          () => received,
          (messages) => messages.length >= 2
        );

        yield* settledStubs;
        yield* Effect.sleep("1 second");

        expect(received[1]).toContain('"requestId":"3"');
        expect(received[1]).toContain('"data":{"n":9}');
        expect(received).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );
});
