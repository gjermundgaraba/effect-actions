import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { HttpClient } from "effect/http";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { commands, connection } from "./commands.js";

// Entrypoint: `node --import tsx examples/notes-service/src/cli.ts list-notes`.
// The commands of commands.ts, connected to a server.
const notes = commands.pipe(
  // Provided on the command, never around `Command.run`: the URL and the token are then read
  // when a command runs, so `--help` and a mistyped flag need neither.
  Command.provideEffect(HttpClient.HttpClient, connection),
);

// A result is printed on stdout. A failure goes to stderr, under an `ERROR` heading, as the JSON
// HTTP sends, such as `{"_tag":"NoteNotFound","id":"9"}`, and the command exits 1.
Command.run(notes, { version: "1.0.0" }).pipe(
  Effect.provide([NodeHttpClient.layerUndici, NodeServices.layer]),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
