import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import * as Action from "../../src/contract/Action.js";
import * as ActionCli from "../../src/cli/ActionCli.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { exec, printed } from "../support/cli-services.js";

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

const Http = ActionHttp.make([Import]);

const expected = [
  Exit.void,
  ['{\n  "imported": 2\n}'],
  ['{"done":1,"total":2}', '{"done":2,"total":2}'],
];

describe("a command of an action reporting progress", () => {
  it.effect("prints each value as a line of JSON on stderr, the answer on stdout", () =>
    Effect.gen(function* () {
      const command = ActionCli.command(imports, Import);

      expect(yield* printed(exec(command, ["--count", "2"]))).toEqual(expected);
    }),
  );

  it.effect("prints them alike over HTTP", () =>
    Effect.gen(function* () {
      const command = ActionCli.remoteCommand(Http, Import);

      expect(yield* printed(exec(command, ["--count", "2"]))).toEqual(expected);
    }).pipe(Effect.provide(Testing.layer(ActionHttp.layer(Http, imports)))),
  );
});
