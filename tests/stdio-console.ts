// A stdio server whose logs go through console loggers that write to `Console.log`: for
// `stdio.test.ts`, which checks they reach stderr, never the protocol on stdout.
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Console, Effect, Logger } from "effect";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";

const Status = Action.make("status", { description: "Report", access: "read" });

const status = Action.implement(Status, () =>
  Effect.log("json logger").pipe(Effect.andThen(Console.log("console log"))),
);

ActionMcp.runStdio(status, { name: "stdio-console", version: "0" }).pipe(
  Effect.provide(Logger.layer([Logger.consoleJson])),
  Effect.provide(NodeStdio.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
