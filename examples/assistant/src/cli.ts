import { userInfo } from "node:os";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { commands } from "./commands.js";
import { CurrentCaller, type Operator } from "./identity/Identity.js";
import { Permissions } from "./identity/permissions.js";
import { tasksFile } from "./platform/tasks-file.js";

// Entrypoint: `node --import tsx examples/assistant/src/cli.ts list-tasks`.
// The operator's own tool. No credential arrives at a terminal, so this host names the caller
// itself: whoever runs the command, as the trusted operator. Being local earns nothing more:
// `authorize` runs here as for a model's tool call, and admits the operator by its kind.
const operator: Operator = { kind: "operator", id: userInfo().username };

const assistant = commands.pipe(
  Command.provide(Layer.mergeAll(tasksFile, Permissions.layerMemory)),
  Command.provideSync(CurrentCaller, operator),
);

// A command's defect, such as a tasks file that does not decode, `runMain` reports on stdout.
// `logToStderr`, applied last, moves that to stderr, so `assistant list-tasks --json | jq` reads
// results alone.
Command.run(assistant, { version: "1.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
