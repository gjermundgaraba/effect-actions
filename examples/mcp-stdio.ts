import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Console, Effect, Layer, Logger, Schema } from "effect";
import { McpProtocol } from "effect/unstable/ai";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionMcp from "../src/ActionMcp.js";

const Status = Action.make("status", {
  description: "Report whether the subprocess is ready.",
  success: Schema.Struct({ ready: Schema.Boolean }),
  access: "read",
});

const app = ActionGroup.make({ name: "stdio" }, Status).implement({
  status: () => Effect.log("status called").pipe(Effect.as({ ready: true })),
});

const layer = ActionMcp.layerStdio([app], {
  name: "effect-actions-stdio",
  version: "0.1.0",
  protocols: [McpProtocol.v2026_07_28],
}).pipe(Layer.provide(NodeStdio.layer));

// Protocol messages use stdout exclusively. Runtime diagnostics remain on stderr.
Layer.launch(layer).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
