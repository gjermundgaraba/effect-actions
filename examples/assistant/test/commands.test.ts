import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stdio, Stream } from "effect";
import { Command } from "effect/cli";
import { TestConsole } from "effect/testing";
import { commands } from "../src/commands.js";
import { CurrentCaller, type Operator } from "../src/identity/Identity.js";
import { Permissions } from "../src/identity/permissions.js";
import { TaskStore } from "../src/tasks/store.js";

// What the commands add to the implementations: their syntax and what they print. The services
// are provided around a test, not on the command as cli.ts does, so the commands of one test
// share one store in memory.
const services = Layer.mergeAll(TaskStore.layerMemory, Permissions.layerMemory);

const operator: Operator = { kind: "operator", id: "root" };

// Effect's own runner, given arguments instead of the process's. `it.effect` provides a console
// that keeps what is printed, and stdin is the text given here.
const run = (args: ReadonlyArray<string>, stdin = "") =>
  Command.runWith(commands.pipe(Command.provideSync(CurrentCaller, operator)), { version: "0" })(
    args,
  ).pipe(
    Effect.andThen(TestConsole.logLines),
    Effect.provide(Stdio.layerTest({ stdin: Stream.make(new TextEncoder().encode(stdin)) })),
    Effect.provide(NodeServices.layer),
  );

describe("the commands", () => {
  it.effect("run as the operator the host names, taking an argument and stdin", () =>
    Effect.gen(function* () {
      yield* run(["add-task", "--title", "Rotate the keys", "--assignee", "ada"]);
      yield* run(["annotate-task", "--id", "1"], "Before Friday.\n");
      yield* run(["complete-task", "1"]);

      const store = yield* TaskStore;

      expect(yield* store.list("ada")).toMatchObject([
        { addedBy: "root", notes: "Before Friday.", done: true },
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("print what `render` returns, and JSON where a command states none", () =>
    Effect.gen(function* () {
      yield* run(["add-task", "--title", "Rotate the keys", "--assignee", "ada"]);

      const printed = yield* run(["list-tasks", "-a", "ada"]);

      expect(printed.at(-1)).toBe("[ ] 1 Rotate the keys (ada)");

      const json = yield* run(["who-am-i"]);

      expect(json.at(-1)).toBe(JSON.stringify({ id: "root", kind: "operator" }, undefined, 2));
    }).pipe(Effect.provide(services)),
  );
});
