import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Cause, Console, Effect, Logger, Runtime, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";

const Status = Action.make("status", {
  description: "Report whether the subprocess is ready.",
  success: { ready: Schema.Boolean },
  access: "read",
});

const status = Action.implement(Status, () =>
  Effect.log("status called").pipe(Effect.as({ ready: true })),
);

// Serves until the host closes stdin, then exits 0. Protocol messages use stdout
// exclusively: runStdio sends its own Effect logs to stderr, and `LogToStderr` those of
// the services provided around it.
ActionMcp.runStdio(status, { name: "effect-actions-stdio", version: "0.1.0" }).pipe(
  Effect.provide(NodeStdio.layer),
  // Report a failure as runMain would, but on stderr.
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause))
      ? Effect.void
      : Console.error(Cause.pretty(cause)),
  ),
  // Outermost, so every layer provided above it logs to stderr too.
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
