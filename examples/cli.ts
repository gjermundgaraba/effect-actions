import { Console, Effect, Logger } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "../src/ActionCli.js";
import { actors, authorize, CurrentActor } from "./auth.js";
import { UserApp } from "./handlers.js";
import { Users } from "./users.js";

// The CLI binds the same hook as the servers; a local caller is not trusted more.
const command = ActionCli.command(UserApp, "double", {
  parameters: { value: Flag.String("value") },
  input: ({ value }) => ({ value }),
  before: authorize,
});

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  // The hook runs here too, so a local caller supplies an identity for it
  // exactly as HTTP middleware does for a request.
  Effect.provideService(CurrentActor, actors.alice),
  Effect.provide(Users.layerMemory),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
