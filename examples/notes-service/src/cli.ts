import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { Effect } from "effect";
import { Command } from "effect/cli";

import { commands } from "./commands.js";

// Entrypoint: `node --import tsx examples/notes-service/src/cli.ts list-notes`.
// The commands of commands.ts, which read where the server is and the token when one runs.
Command.run(commands, { version: "1.0.0" }).pipe(
  Effect.provide([NodeHttpClient.layerUndici, NodeServices.layer]),
  ActionCli.logToStderr,
  NodeRuntime.runMain()
);
