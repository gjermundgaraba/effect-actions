import { userInfo } from "node:os";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";

import { commands } from "./commands.js";
import { CurrentCaller } from "./identity/Identity.js";
import type { Operator } from "./identity/Identity.js";
import { Permissions } from "./identity/permissions.js";
import { demoTasksFile } from "./platform/tasks-file.js";

const operator: Operator = { kind: "operator", id: userInfo().username };

const assistant = commands.pipe(
  Command.provide(Layer.mergeAll(demoTasksFile, Permissions.layerMemory)),
  Command.provideSync(CurrentCaller, operator)
);

Command.run(assistant, { version: "1.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain()
);
