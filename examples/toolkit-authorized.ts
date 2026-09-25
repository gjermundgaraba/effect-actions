import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, Stream } from "effect";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { actors, authorize, CurrentActor } from "./authorization.js";
import { double, userActions } from "./handlers.js";
import { Users } from "./users.js";

// The in-process caller binds the same hook as the guarded servers.
const { toolkit, layer } = ActionToolkit.make([userActions, double], { before: authorize });

const program = Effect.gen(function* () {
  const tools = yield* toolkit;
  const calls = yield* tools.handle("getUser", { id: "1" }); // encoded arguments
  const results = yield* Stream.runCollect(calls);
  yield* Console.log(results);
}).pipe(
  Effect.provideService(CurrentActor, actors.alice), // identity around the whole invocation
  Effect.provide(layer.pipe(Layer.provide(Users.layerMemory))), // startup services only
);

program.pipe(NodeRuntime.runMain);
