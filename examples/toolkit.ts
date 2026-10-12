import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Stream } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { Greet } from "./quickstart.js";

// A public action: no authorization, and its tool owes no caller.
const greet = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));

const { toolkit, layer } = ActionToolkit.make(greet);

const program = Effect.gen(function* () {
  const tools = yield* toolkit;
  const calls = yield* tools.handle("greet", { name: "Ada" });
  const results = yield* Stream.runCollect(calls);
  yield* Console.log(results);
}).pipe(Effect.provide(layer));

program.pipe(NodeRuntime.runMain);
