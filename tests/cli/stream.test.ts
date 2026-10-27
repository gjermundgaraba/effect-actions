import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, Stream } from "effect";

import * as ActionCli from "../../src/cli/ActionCli.js";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { causeOf, exec, printed } from "../support/cli-services.js";

class LogGone extends Schema.TaggedError<
  LogGone,
  { readonly brand: unique symbol }
>()("LogGone", {
  at: Schema.Finite,
}) {}

const Build = Action.make("build", {
  description: "Stream a build's lines, reporting its step.",
  input: { steps: Schema.Finite, goneAt: Schema.optional(Schema.Finite) },
  success: Action.Stream({ line: Schema.String }),
  progress: { step: Schema.Finite },
  error: LogGone,
  readOnly: false,
  caller: Action.Anyone,
});

const builds = Action.implement(Build, ({ steps, goneAt }, { progress }) =>
  Stream.mapEffect(Stream.range(1, steps), (step) =>
    step === goneAt
      ? Effect.fail(new LogGone({ at: step }))
      : Effect.as(progress({ step }), { line: `step ${step}` })
  )
);

const Http = ActionHttp.make([Build]);

const expected = {
  exit: Exit.void,
  stdout: ['{"line":"step 1"}', '{"line":"step 2"}'],
  stderr: ['{"step":1}', '{"step":2}'],
};

describe("a command of an action answering a stream", () => {
  it.effect(
    "prints each element as a line of JSON on stdout, progress on stderr",
    () =>
      Effect.gen(function* () {
        const command = ActionCli.command(builds, Build);

        expect(yield* printed(exec(command, ["--steps", "2"]))).toStrictEqual(
          expected
        );
      })
  );

  it.effect("prints them alike over HTTP", () =>
    Effect.gen(function* () {
      const command = ActionCli.remoteCommand(Http, Build);

      expect(yield* printed(exec(command, ["--steps", "2"]))).toStrictEqual(
        expected
      );
    }).pipe(Effect.provide(Testing.layer(ActionHttp.layer(Http, builds))))
  );

  it.effect("prints each element by render, and JSON under --json", () =>
    Effect.gen(function* () {
      const command = ActionCli.command(builds, Build, {
        render: ({ line }) => `> ${line}`,
      });

      const { stdout: rendered } = yield* printed(
        exec(command, ["--steps", "2"])
      );

      const { stdout: json } = yield* printed(
        exec(command, ["--steps", "1", "--json"])
      );

      expect([rendered, json]).toStrictEqual([
        ["> step 1", "> step 2"],
        ['{"line":"step 1"}'],
      ]);
    })
  );

  it.effect(
    "prints the elements before a declared failure, then fails with it",
    () =>
      Effect.gen(function* () {
        const command = ActionCli.command(builds, Build);

        const { exit, stdout: lines } = yield* printed(
          exec(command, ["--steps", "3", "--gone-at", "2"])
        );

        expect([lines, causeOf(exit)]).toStrictEqual([
          ['{"line":"step 1"}'],
          new LogGone({ at: 2 }),
        ]);
      })
  );

  it.effect(
    "reads the stream while what the implementation's builder acquired is open",
    () =>
      Effect.gen(function* () {
        const Read = Action.make("read", {
          description: "Read whether the builder's resource is open.",
          success: Action.Stream({ open: Schema.Boolean }),
          readOnly: true,
          caller: Action.Anyone,
        });

        const reading = Action.implement(
          Read,
          Effect.gen(function* () {
            let open = true;

            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                open = false;
              })
            );

            return () => Stream.fromEffect(Effect.sync(() => ({ open })));
          })
        );

        const { stdout: lines } = yield* printed(
          exec(ActionCli.command(reading, Read), [])
        );

        expect(lines).toStrictEqual(['{"open":true}']);
      })
  );

  it.effect(
    "fails with a defect at an element breaking its schema, render or not",
    () =>
      Effect.gen(function* () {
        const breaking = Action.implement(
          Build,
          // @ts-expect-error -- An element breaking its schema, as a handler the types were bypassed for gives it.
          () => Stream.make({ line: 1 })
        );

        const rendered = ActionCli.command(breaking, Build, {
          render: ({ line }) => `> ${line}`,
        });

        for (const command of [ActionCli.command(breaking, Build), rendered]) {
          const { exit, stdout: lines } = yield* printed(
            exec(command, ["--steps", "1"])
          );

          expect([Exit.hasDies(exit), lines]).toStrictEqual([true, []]);
        }
      })
  );
});
