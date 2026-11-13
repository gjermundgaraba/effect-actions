import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { BoardRpc, Hooked, hooks } from "../board.js";
import { clientOver, opened, stubs, watchingIn } from "../support/socket.js";
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
});
