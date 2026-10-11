import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Option } from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { Http } from "./Api.js";

// Entrypoint: `node --import tsx examples/notes-service/src/cli.ts list-notes`.
// A command per action of the binding, a flag per input field, each calling the server over
// HTTP. It imports the binding alone, never a handler.
const notes = ActionCli.remote(Http, {
  name: "notes",
  commands: {
    // `notes create-note --title Draft < draft.md`: the body is piped in, not a flag.
    createNote: { stdin: "body" },
    getNote: { positional: ["id"], render: (note) => `# ${note.title}\n\n${note.body}` },
    // `notes update-note <id> --revision 1 < draft.md`: an argument, a flag and stdin together.
    updateNote: { positional: ["id"], stdin: "body" },
  },
}).pipe(
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
