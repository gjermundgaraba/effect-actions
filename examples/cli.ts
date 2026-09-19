import { Console, Effect, Logger } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "../src/ActionCli.js";
import { UserApp } from "./handlers.js";
import { Users } from "./users.js";

const command = ActionCli.command(UserApp, "double", {
  parameters: { value: Flag.String("value") },
  input: ({ value }) => ({ value }),
});

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(Users.layerMemory),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
