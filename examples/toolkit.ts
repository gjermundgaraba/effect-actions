import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Schema, Stream } from "effect";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionToolkit from "../src/ActionToolkit.js";

const Double = Action.make("double", {
  description: "Double a finite number.",
  input: Schema.Struct({ value: Schema.FiniteFromString }),
  success: Schema.Finite,
  access: "read",
});

const app = ActionGroup.make({ name: "math" }, Double).implement({
  double: ({ value }) => Effect.succeed(value * 2),
});

const binding = ActionToolkit.make([app]);

const program = Effect.gen(function* () {
  const tools = yield* binding.toolkit;
  const calls = yield* tools.handle("double", { value: "21" });
  const results = yield* Stream.runCollect(calls);
  yield* Console.log(results);
}).pipe(Effect.provide(binding.layer));

program.pipe(NodeRuntime.runMain);
