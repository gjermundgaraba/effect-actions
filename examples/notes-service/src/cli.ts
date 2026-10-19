import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { commands } from "./commands.js";

// Entrypoint: `node --import tsx examples/notes-service/src/cli.ts list-notes`.
// The commands of commands.ts, which read where the server is and the token when one runs.
Command.run(commands, { version: "1.0.0" }).pipe(
  Effect.provide([NodeHttpClient.layerUndici, NodeServices.layer]),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
