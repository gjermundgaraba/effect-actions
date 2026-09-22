import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, Stream } from "effect";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { actors, authorize, CurrentActor, Forbidden } from "./auth.js";
import { UserApp } from "./handlers.js";
import { Users } from "./users.js";

// The in-process caller binds the same rule as the guarded servers.
const binding = ActionToolkit.make([UserApp], { errors: [Forbidden], before: authorize });

const program = Effect.gen(function* () {
  const tools = yield* binding.toolkit;
  const calls = yield* tools.handle("get_user", { id: "1" }); // encoded arguments
  const results = yield* Stream.runCollect(calls);
  yield* Console.log(results);
}).pipe(
  Effect.provideService(CurrentActor, actors.alice), // identity around the whole invocation
  Effect.provide(binding.layer.pipe(Layer.provide(Users.layerMemory))), // startup services only
);

program.pipe(NodeRuntime.runMain);
