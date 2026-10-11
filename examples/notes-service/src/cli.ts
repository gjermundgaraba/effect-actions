import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Option } from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { commands } from "./commands.js";

// Entrypoint: `node --import tsx examples/notes-service/src/cli.ts list-notes`.
// The commands of commands.ts, connected to a server.
const notes = commands.pipe(
  // The URL and the token are read when a command runs, so `--help` needs neither.
  Command.provideEffect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const url = yield* Config.String("NOTES_URL").pipe(
        Config.withDefault("http://127.0.0.1:3000"),
      );

      // Optional: the public `get-status` needs no token.
      const token = yield* Config.option(Config.Redacted("NOTES_TOKEN"));

      const client = HttpClient.mapRequest(
        yield* HttpClient.HttpClient,
        HttpClientRequest.prependUrl(url),
      );

      return Option.match(token, {
        onNone: () => client,
        onSome: (value) => HttpClient.mapRequest(client, HttpClientRequest.bearerToken(value)),
      });
    }),
  ),
);

// A result is printed on stdout. A failure goes to stderr, under an `ERROR` heading, as the JSON
// HTTP sends, such as `{"_tag":"NoteNotFound","id":"9"}`, and the command exits 1.
Command.run(notes, { version: "1.0.0" }).pipe(
  Effect.provide([NodeHttpClient.layerUndici, NodeServices.layer]),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
