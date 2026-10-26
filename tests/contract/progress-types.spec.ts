import { describe, expectTypeOf, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Action from "../../src/contract/Action.js";

const Reporting = Action.make("reporting", {
  description: "Reports progress.",
  progress: { done: Schema.Finite },
  readOnly: true,
  caller: Action.Anyone,
});

const Silent = Action.make("silent", {
  description: "Reports nothing.",
  readOnly: true,
  caller: Action.Anyone,
});

describe("Action.make's progress", () => {
  it("types the progress schema, undefined where none is declared", () => {
    expectTypeOf(Reporting.progress.Type).toEqualTypeOf<{ readonly done: number }>();
    expectTypeOf(Silent.progress).toEqualTypeOf<undefined>();
  });

  it("gives a handler its progress only where the action declares it", () => {
    Action.implement(Reporting, (_input, { progress }) => progress({ done: 1 }));

    // @ts-expect-error -- A value of another shape than the progress schema's.
    Action.implement(Reporting, (_input, { progress }) => progress({ done: "1" }));

    expectTypeOf<Parameters<Action.Handler<typeof Silent>>>().toEqualTypeOf<
      [typeof Silent.input.Type]
    >();
  });

  it("takes onProgress after the input where the action declares progress", () =>
    Effect.gen(function* () {
      const client = yield* Action.client([
        Action.implement(Reporting, () => Effect.void),
        Action.implement(Silent, () => Effect.void),
      ]);

      yield* client.reporting(
        {},
        {
          onProgress: (value) => {
            expectTypeOf(value).toEqualTypeOf<{ readonly done: number }>();

            return Effect.void;
          },
        },
      );

      // @ts-expect-error -- No options where no progress is declared.
      yield* client.silent({}, { onProgress: () => Effect.void });
    }));
});
