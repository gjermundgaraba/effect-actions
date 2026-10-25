import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Schema } from "effect";
import * as Action from "../../src/contract/Action.js";

const Import = Action.make("importAll", {
  description: "Import every item, reporting how many are done.",
  input: { count: Schema.Finite },
  success: { imported: Schema.Finite },
  progress: { done: Schema.Finite, total: Schema.Finite },
  readOnly: false,
  caller: Action.Anyone,
});

const imports = Action.implement(Import, ({ count }, { progress }) =>
  Effect.as(
    Effect.forEach(
      Array.from({ length: count }, (_, index) => index + 1),
      (done) => progress({ done, total: count }),
    ),
    { imported: count },
  ),
);

describe("an action reporting progress, in process", () => {
  it.effect("hands each value to onProgress, in order, before it answers", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(imports);
      const seen: Array<number> = [];

      const answer = yield* client.importAll(
        { count: 3 },
        { onProgress: ({ done }) => Effect.sync(() => seen.push(done)) },
      );

      expect([seen, answer]).toEqual([[1, 2, 3], { imported: 3 }]);
    }),
  );

  it.effect("answers alike without onProgress", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(imports);

      expect(yield* client.importAll({ count: 3 })).toEqual({ imported: 3 });
    }),
  );

  it.effect(
    "drops the oldest values a slow caller falls behind on, never the last one or the answer",
    () =>
      Effect.gen(function* () {
        const client = yield* Action.client(imports);
        const gate = yield* Deferred.make<void>();
        const seen: Array<number> = [];

        const call = yield* Effect.forkChild(
          client.importAll(
            { count: 100 },
            {
              onProgress: ({ done }) =>
                Effect.andThen(
                  Effect.sync(() => seen.push(done)),
                  Deferred.await(gate),
                ),
            },
          ),
        );

        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        yield* Deferred.succeed(gate, undefined);

        const answer = yield* Fiber.join(call);

        expect(answer).toEqual({ imported: 100 });
        expect(seen.length).toBeLessThan(100);
        expect(seen.at(-1)).toBe(100);
        expect(seen).toEqual([...seen].sort((left, right) => left - right));
      }),
  );

  it.effect("fails with a defect where a value breaks the progress schema", () =>
    Effect.gen(function* () {
      const broken = Action.implement(Import, (_input, { progress }) =>
        Effect.as(progress({ done: Number.NaN, total: 1 }), { imported: 0 }),
      );

      const client = yield* Action.client(broken);

      const exit = yield* Effect.exit(
        client.importAll({ count: 1 }, { onProgress: () => Effect.void }),
      );

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }),
  );

  it.effect("answers where onProgress dies or throws, the handler running to its end", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(imports);
      const logged: Array<string> = [];

      const broken = new Error("the page broke");

      const answers = yield* Effect.forEach(
        [
          () => Effect.die(broken),
          () => {
            throw broken;
          },
        ],
        (onProgress) => client.importAll({ count: 2 }, { onProgress }),
      ).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              logged.push(String(message));
            }),
          ]),
        ),
      );

      expect(answers).toEqual([{ imported: 2 }, { imported: 2 }]);
      expect(
        logged.filter((line) => line.includes("onProgress failed")).length,
      ).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect("interrupts the handler where its caller is interrupted", () =>
    Effect.gen(function* () {
      const reported = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();

      const waits = Action.implement(Import, (_input, { progress }) =>
        Effect.andThen(progress({ done: 1, total: 2 }), Effect.never).pipe(
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      );

      const client = yield* Action.client(waits);

      const call = yield* Effect.forkChild(
        client.importAll({ count: 2 }, { onProgress: () => Deferred.succeed(reported, undefined) }),
      );

      yield* Deferred.await(reported);
      yield* Fiber.interrupt(call);

      expect(yield* Deferred.isDone(interrupted)).toBe(true);
    }),
  );

  it.effect("drops a value reported after the answer", () =>
    Effect.gen(function* () {
      const late = yield* Deferred.make<void>();
      const seen: Array<number> = [];

      const forks = Action.implement(Import, (_input, { progress }) =>
        Effect.as(
          Effect.forkDetach(Effect.andThen(Deferred.await(late), progress({ done: 2, total: 2 }))),
          { imported: 1 },
        ),
      );

      const client = yield* Action.client(forks);

      const answer = yield* client.importAll(
        { count: 1 },
        { onProgress: ({ done }) => Effect.sync(() => seen.push(done)) },
      );

      yield* Deferred.succeed(late, undefined);
      yield* Effect.repeat(Effect.yieldNow, { times: 10 });

      expect([answer, seen]).toEqual([{ imported: 1 }, []]);
    }),
  );
});
