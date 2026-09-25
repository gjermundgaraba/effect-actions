import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Schema, Stream } from "effect";
import * as Action from "../src/Action.js";
import * as ActionToolkit from "../src/ActionToolkit.js";

const Double = Action.make("double", {
  description: "Double a finite number.",
  input: { value: Schema.FiniteFromString },
  success: Schema.Finite,
  access: "read",
});

const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2));

const { toolkit, layer } = ActionToolkit.make(double);

const program = Effect.gen(function* () {
  const tools = yield* toolkit;
  const calls = yield* tools.handle("double", { value: "21" });
  const results = yield* Stream.runCollect(calls);
  yield* Console.log(results);
}).pipe(Effect.provide(layer));

program.pipe(NodeRuntime.runMain);
