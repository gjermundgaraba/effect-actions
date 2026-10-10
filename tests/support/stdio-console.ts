import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Console, Effect, Logger } from "effect";
import * as Action from "../../src/contract/Action.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import { everyConsoleMethod } from "./console-methods.js";

const Status = Action.make("status", {
  description: "Report",
  readOnly: true,
  caller: Action.Anyone,
});

const status = Action.implement(
  Status,
  Effect.as(
    everyConsoleMethod(() => Effect.void),
    () => Effect.log("json logger").pipe(Effect.andThen(Console.log("console log"))),
  ),
);

ActionMcp.runStdio(status, { name: "stdio-console", version: "0" }).pipe(
  Effect.provide(Logger.layer([Logger.consoleJson])),
  Effect.provide(NodeStdio.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
