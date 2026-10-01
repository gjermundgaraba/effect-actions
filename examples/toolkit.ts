import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Stream } from "effect";
import * as Action from "../src/Action.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { Double } from "./contracts.js";

const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2), Action.allowAll);

const { toolkit, layer } = ActionToolkit.make(double);

const program = Effect.gen(function* () {
  const tools = yield* toolkit;
  const calls = yield* tools.handle("double", { value: "21" });
  const results = yield* Stream.runCollect(calls);
  yield* Console.log(results);
}).pipe(Effect.provide(layer));

program.pipe(NodeRuntime.runMain);
