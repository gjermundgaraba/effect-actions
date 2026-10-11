import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

const Status = Action.make("status", {
  description: "Report whether the subprocess is ready.",
  success: { ready: Schema.Boolean },
  readOnly: true,
  caller: Action.Anyone,
});

const status = Action.implement(Status, () =>
  Effect.log("status called").pipe(Effect.as({ ready: true })),
);

ActionMcp.runStdio(status, { name: "effect-actions-stdio", version: "0.1.0" }).pipe(
  Effect.provide(NodeStdio.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
