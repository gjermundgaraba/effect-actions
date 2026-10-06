import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionCli from "../src/ActionCli.js";
import * as ActionMcp from "../src/ActionMcp.js";

const Status = Action.make("status", {
  description: "Report whether the subprocess is ready.",
  success: { ready: Schema.Boolean },
  access: "read",
  auth: "public",
});

const status = Action.implement(Status, () =>
  Effect.log("status called").pipe(Effect.as({ ready: true })),
);

// Serves until the host closes stdin, then exits 0. Protocol messages use stdout
// exclusively: runStdio writes its program's Effect logs and `Console` output to stderr, and
// `onStderr`, applied last, does so for the layers provided around it, and reports a failure
// there rather than as runMain would, on stdout.
ActionMcp.runStdio(status, { name: "effect-actions-stdio", version: "0.1.0" }).pipe(
  Effect.provide(NodeStdio.layer),
  ActionCli.onStderr,
  NodeRuntime.runMain,
);
