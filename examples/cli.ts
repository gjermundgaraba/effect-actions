import { Cause, Console, Effect, Logger, Runtime } from "effect";
import { Command } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "../src/ActionCli.js";
import { actors, CurrentActor } from "./authorization.js";
import { Double } from "./contracts.js";
import { double } from "./handlers.js";

// `double --value 21`: one flag per input field. The implementation's hook runs here as
// on the servers; a local caller is not trusted more.
const command = ActionCli.command(double, Double);

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  // Report a failure as runMain would, but on stderr, and none the CLI has printed.
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause))
      ? Effect.void
      : Console.error(Cause.pretty(cause)),
  ),
  Effect.provideService(Logger.LogToStderr, true),
  // No remote caller to authenticate: the host supplies the identity the hook reads.
  Effect.provideService(CurrentActor, actors.alice),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
