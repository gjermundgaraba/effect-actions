import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Effect, Layer } from "effect";

import { serverInfo } from "./instructions.js";
import { fakeFarm } from "./platform/fake-farm.js";
import { printFarm } from "./platform/print-farm.js";
import { printers } from "./printers/handlers.js";

ActionMcp.runStdio(printers, serverInfo).pipe(
  Effect.provide([NodeStdio.layer, printFarm.pipe(Layer.provide(fakeFarm))]),
  ActionCli.logToStderr,
  NodeRuntime.runMain()
);
