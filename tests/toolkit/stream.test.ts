import { describe, expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Schema, Stream } from "effect";

import * as Action from "../../src/contract/Action.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";

const Line = Schema.Struct({ n: Schema.Finite, text: Schema.String });

const Tail = Action.make("tail", {
  description: "Follow the lines given.",
  input: { lines: Schema.Array(Line) },
  success: Action.Stream(Line),
  readOnly: true,
  caller: Action.Anyone,
});

const binding = ActionToolkit.make(
  Action.implement(Tail, ({ lines }) => Stream.fromIterable(lines))
);

describe("a tool of an action answering a stream", () => {
  it.effect.prop(
    "answers the generated elements collected in order into one result, once the stream ends",
    [Arbitrary.schema(Schema.Array(Line))],
    ([lines]) =>
      Effect.gen(function* () {
        const results = yield* Effect.gen(function* () {
          const tools = yield* binding.toolkit;

          return yield* Stream.runCollect(
            yield* tools.handle("tail", { lines })
          );
        }).pipe(Effect.provide(binding.layer));

        expect(results).toMatchObject([
          {
            result: lines,
            encodedResult: lines,
            isFailure: false,
            preliminary: false,
          },
        ]);
      }),
    { arbitrary: { runs: 100 } }
  );
});
