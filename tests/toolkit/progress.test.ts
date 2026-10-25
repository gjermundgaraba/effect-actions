import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import * as Action from "../../src/contract/Action.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";

const Import = Action.make("importAll", {
  description: "Import every item, reporting how many are done.",
  input: { count: Schema.Finite },
  success: { imported: Schema.Finite },
  progress: { imported: Schema.Finite, total: Schema.Finite },
  readOnly: false,
  caller: Action.Anyone,
});

const Touch = Action.make("touch", {
  description: "Touch, reporting how many are touched.",
  input: { count: Schema.Finite },
  progress: { touched: Schema.Finite },
  readOnly: false,
  caller: Action.Anyone,
});

describe("a tool of an action reporting progress", () => {
  it.effect("streams each value as a tagged preliminary result, then the result", () =>
    Effect.gen(function* () {
      const binding = ActionToolkit.make(
        Action.implement(Import, ({ count }, { progress }) =>
          Effect.as(progress({ imported: count, total: count }), { imported: count }),
        ),
      );

      const results = yield* Effect.gen(function* () {
        const tools = yield* binding.toolkit;

        return yield* Stream.runCollect(yield* tools.handle("importAll", { count: 2 }));
      }).pipe(Effect.provide(binding.layer));

      expect(results).toMatchObject([
        {
          result: { _tag: "Progress", value: { imported: 2, total: 2 } },
          encodedResult: { _tag: "Progress", value: { imported: 2, total: 2 } },
          isFailure: false,
          preliminary: true,
        },
        {
          result: { imported: 2 },
          encodedResult: { imported: 2 },
          isFailure: false,
          preliminary: false,
        },
      ]);
    }),
  );

  it.effect("streams the values of an action answering nothing, then its empty result", () =>
    Effect.gen(function* () {
      const binding = ActionToolkit.make(
        Action.implement(Touch, ({ count }, { progress }) => progress({ touched: count })),
      );

      const results = yield* Effect.gen(function* () {
        const tools = yield* binding.toolkit;

        return yield* Stream.runCollect(yield* tools.handle("touch", { count: 2 }));
      }).pipe(Effect.provide(binding.layer));

      expect(results.map(({ encodedResult, preliminary }) => [encodedResult, preliminary])).toEqual(
        [
          [{ _tag: "Progress", value: { touched: 2 } }, true],
          [null, false],
        ],
      );
      expect(results[1]?.result).toBeUndefined();
    }),
  );

  it.effect("encodes a success holding more than a progress value's fields as the success", () =>
    Effect.gen(function* () {
      const Job = Action.make("job", {
        description: "Run a job, reporting its step.",
        success: { _tag: Schema.Literal("Progress"), value: Schema.Finite, jobId: Schema.String },
        progress: Schema.Finite,
        readOnly: false,
        caller: Action.Anyone,
      });

      const binding = ActionToolkit.make(
        Action.implement(Job, (_input, { progress }) =>
          Effect.as(progress(1), { _tag: "Progress" as const, value: 3, jobId: "job-1" }),
        ),
      );

      const results = yield* Effect.gen(function* () {
        const tools = yield* binding.toolkit;

        return yield* Stream.runCollect(yield* tools.handle("job", {}));
      }).pipe(Effect.provide(binding.layer));

      expect(results.map(({ encodedResult, preliminary }) => [encodedResult, preliminary])).toEqual(
        [
          [{ _tag: "Progress", value: 1 }, true],
          [{ _tag: "Progress", value: 3, jobId: "job-1" }, false],
        ],
      );
    }),
  );

  it.effect(
    "encodes a success whose value holds more than a progress value's fields as the success",
    () =>
      Effect.gen(function* () {
        const Job = Action.make("job", {
          description: "Run a job, reporting its step.",
          success: {
            _tag: Schema.Literal("Progress"),
            value: Schema.Struct({ step: Schema.Int, result: Schema.String }),
          },
          progress: Schema.Struct({ step: Schema.Int }),
          readOnly: false,
          caller: Action.Anyone,
        });

        const binding = ActionToolkit.make(
          Action.implement(Job, (_input, { progress }) =>
            Effect.as(progress({ step: 1 }), {
              _tag: "Progress" as const,
              value: { step: 3, result: "committed" },
            }),
          ),
        );

        const results = yield* Effect.gen(function* () {
          const tools = yield* binding.toolkit;

          return yield* Stream.runCollect(yield* tools.handle("job", {}));
        }).pipe(Effect.provide(binding.layer));

        expect(
          results.map(({ encodedResult, preliminary }) => [encodedResult, preliminary]),
        ).toEqual([
          [{ _tag: "Progress", value: { step: 1 } }, true],
          [{ _tag: "Progress", value: { step: 3, result: "committed" } }, false],
        ]);
      }),
  );
});
