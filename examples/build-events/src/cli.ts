import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { commands } from "./commands.js";

// Entrypoint: `BUILDS_TOKEN=grace node --import tsx examples/build-events/src/cli.ts watch
// build.finished`, with server.ts running.
Command.run(commands, { version: "1.0.0" }).pipe(
  Effect.provide([NodeHttpClient.layerUndici, NodeServices.layer]),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
