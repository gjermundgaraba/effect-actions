import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { commands } from "./commands.js";

// Entrypoint: `node --import tsx examples/notes-service/src/cli.ts list-notes`.
// The commands of commands.ts, which read where the server is and the token when one runs.

// A result is printed on stdout. A failure goes to stderr, under an `ERROR` heading, as the JSON
// HTTP sends, such as `{"_tag":"NoteNotFound","id":"9"}`, and the command exits 1.
Command.run(commands, { version: "1.0.0" }).pipe(
  Effect.provide([NodeHttpClient.layerUndici, NodeServices.layer]),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
