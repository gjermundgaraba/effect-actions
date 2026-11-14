import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, Scope, Stream } from "effect";

import { BoardRpc, Logged, Pinned } from "../board.js";
import { eventually } from "../support/eventually.js";
import {
  clientOver,
  evictIfRunning,
  reconnecting,
  watchingIn,
} from "../support/socket.js";
import { boards } from "../support/watch.js";
import { throughWorker } from "../support/worker.js";

const Command = Schema.Union([
  Schema.TaggedStruct("Pin", {}),
  Schema.TaggedStruct("Pins", {
    count: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 3 })),
  }),
  Schema.TaggedStruct("Evict", {}),
  Schema.TaggedStruct("Reconnect", { watcher: Schema.Literals([0, 1]) }),
  Schema.TaggedStruct("Wait", {
    millis: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1500 })),
  }),
]);

type Command = typeof Command.Type;

interface Watcher {
  readonly event: typeof Pinned | typeof Logged;
  readonly received: Array<number | "gap">;
  cursor: string | null;
  from: number;
  scope: Scope.Closeable;
}

let scenarios = 0;

const scenario = (commands: readonly Command[]) =>
  Effect.gen(function* () {
    scenarios += 1;

    const board = `model-${scenarios}`;

    const http = yield* boards;

    const pinned: number[] = [];

    const watchers: Watcher[] = yield* Effect.forEach(
      [Pinned, Logged],
      (event) =>
        Effect.map(Scope.make(), (scope) => ({
          event,
          received: [],
          cursor: null,
          from: 0,
          scope,
        }))
    );

    const connect = (watcher: Watcher) =>
      Effect.gen(function* () {
        const protocol = yield* Scope.provide(
          reconnecting("Board", board),
          watcher.scope
        );

        const client = yield* clientOver(BoardRpc, { protocol });

        yield* client
          .watch(watcher.event, { board }, { cursor: watcher.cursor })
          .pipe(
            Stream.runForEach((item) =>
              Effect.sync(() => {
                watcher.received.push(
                  item._tag === "Occurrence" ? item.data.n : "gap"
                );
                watcher.cursor = item.cursor ?? watcher.cursor;
              })
            ),
            Effect.forkIn(watcher.scope)
          );
      });

    yield* Effect.forEach(watchers, connect, { discard: true });
    yield* watchingIn("Board", board, watchers.length);

    for (const command of commands) {
      switch (command._tag) {
        case "Pin":
        case "Pins": {
          const count = command._tag === "Pin" ? 1 : command.count;

          for (let index = 0; index < count; index += 1) {
            const n = pinned.length + 1;

            pinned.push(n);
            yield* http.pin({ board, n });
          }

          break;
        }

        case "Evict": {
          yield* evictIfRunning("Board", board);

          break;
        }

        case "Reconnect": {
          const watcher = watchers[command.watcher];

          if (watcher !== undefined) {
            yield* Scope.close(watcher.scope, Exit.void);

            if (watcher.cursor === null) {
              watcher.from = pinned.length;
            }

            watcher.scope = yield* Scope.make();
            yield* connect(watcher);

            if (watcher.cursor === null) {
              yield* watchingIn("Board", board, watchers.length);
            }
          }

          break;
        }

        case "Wait": {
          yield* Effect.sleep(command.millis);

          break;
        }
      }
    }

    yield* Effect.sync(() =>
      watchers.map(({ received }) => received.length)
    ).pipe(
      eventually(
        (lengths) =>
          lengths.every(
            (length, index) =>
              length >= pinned.length - (watchers[index]?.from ?? 0)
          ),
        "30 seconds"
      ),
      Effect.ignore
    );

    yield* Effect.sleep("1500 millis");

    yield* Effect.forEach(
      watchers,
      ({ scope }) => Scope.close(scope, Exit.void),
      { discard: true }
    );

    return watchers.map(({ received, from }) => ({
      received,
      expected: pinned.slice(from),
    }));
  }).pipe(Effect.provide(throughWorker));

it.live.prop(
  "delivers every pin past each socket watch's cursor once, in order, across evictions and reconnects from the cursor it reached, or from the reconnect where it reached none",
  {
    commands: Schema.Array(Command).check(Schema.isBetweenLength(3, 8)),
  },
  ({ commands }) =>
    Effect.map(scenario(commands), (watched) => {
      expect(watched.map(({ received }) => received)).toStrictEqual(
        watched.map(({ expected }) => expected)
      );
    }),
  { timeout: 600_000, arbitrary: { runs: 8 } }
);
