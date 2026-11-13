import { describe, expect, it } from "@effect/vitest";
import { Effect, Schedule } from "effect";

import { BoardRpc, Hooked, hooks, Leased, Pinned } from "../board.js";
import {
  answeredEarlier,
  clientOver,
  opened,
  pollOf,
  raw,
  stubs,
  until,
  watchingIn,
} from "../support/socket.js";
import { boards, following, notes, throughWorker } from "../support/watch.js";

const instancesOf = (board: string) =>
  Effect.map(stubs, ({ instances }) =>
    instances.filter((instance) => instance.includes(board))
  );

const hooksOf = (board: string) =>
  hooks.filter((hook) => hook.endsWith(` ${board}`));

describe("ActionClusterEntity's subscription hooks", () => {
  it.live(
    "keeps the object of a page watching a hooked source awake through 20 idle seconds, its hook held once",
    () =>
      Effect.gen(function* () {
        const board = "hooked-idle";
        const http = yield* boards;
        const watching = yield* opened("Board", board);

        const pins = yield* following(
          (yield* clientOver(BoardRpc, watching)).watch(Hooked, { board })
        );

        yield* watchingIn("Board", board, 1);

        const before = yield* instancesOf(board);

        yield* Effect.sleep("20 seconds");

        const idle = hooksOf(board);

        yield* http.pin({ board, n: 1 });

        const pinned = yield* notes(pins, 1);

        expect(pinned).toStrictEqual([{ n: 1 }]);
        expect(idle).toStrictEqual([`set up ${board}`]);
        expect(yield* instancesOf(board)).toStrictEqual(before);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );

  it.live(
    "lets the object of a page watching a hooked source hibernate once the hook's lease lapsed",
    () =>
      Effect.gen(function* () {
        const board = "lapsed-idle";
        const http = yield* boards;
        const watching = yield* opened("Board", board);

        const pins = yield* following(
          (yield* clientOver(BoardRpc, watching)).watch(Leased, { board })
        );

        yield* watchingIn("Board", board, 1);

        const before = yield* instancesOf(board);

        yield* Effect.sync(() => hooksOf(board)).pipe(
          Effect.repeat({
            until: (seen) => seen.length > 1,
            schedule: Schedule.spaced("100 millis"),
          }),
          Effect.timeout("40 seconds")
        );
        yield* Effect.sleep("25 seconds");
        yield* http.pin({ board, n: 1 });

        const pinned = yield* notes(pins, 1);

        expect(pinned).toStrictEqual([{ n: 1 }]);
        expect(yield* instancesOf(board)).not.toStrictEqual(before);
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 90_000 }
  );

  it.live(
    "renews a hook's lease with a page's poll sent to the entity 30 seconds or more after its last, lets it lapse while the next is parked, and sets it up again as that poll is sent",
    () =>
      Effect.gen(function* () {
        const board = "leased";
        const http = yield* boards;
        const { socket, received } = yield* raw("Board", board);
        const poll = pollOf(socket, Leased.name, board);
        const watch = crypto.randomUUID();

        const unhookedBuildingTheChangeSignal = pollOf(
          socket,
          Pinned.name,
          board
        );

        unhookedBuildingTheChangeSignal("0", crypto.randomUUID(), null);

        yield* until(
          () => received,
          (messages) => messages.length >= 1
        );

        poll("1", watch, null);

        yield* until(
          () => received,
          (messages) => messages.length >= 2
        );

        yield* Effect.sleep("5 seconds");
        yield* answeredEarlier("Board", board, watch, 30_000);
        poll("2", watch, "0");
        yield* watchingIn("Board", board, 1);
        yield* Effect.sleep("7500 millis");

        const pastFirstLease = hooksOf(board);

        yield* until(
          () => hooksOf(board),
          (seen) => seen.length > 1
        );
        yield* http.pin({ board, n: 1 });

        yield* until(
          () => received,
          (messages) => messages.length >= 3
        );

        expect(pastFirstLease).toStrictEqual([`set up ${board}`]);
        expect(hooksOf(board)).toStrictEqual([
          `set up ${board}`,
          `torn down ${board}`,
          `set up ${board}`,
        ]);
        expect(received[2]).toContain('"requestId":"2"');
        expect(received[2]).toContain('"data":{"n":1}');
      }).pipe(Effect.scoped, Effect.provide(throughWorker)),
    { timeout: 60_000 }
  );
});
