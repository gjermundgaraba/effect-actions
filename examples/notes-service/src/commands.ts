import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Config, Console, Effect, FileSystem, Schema } from "effect";
import { Argument, CliError, Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "./Api.js";

class MissingToken extends Schema.TaggedError<
  MissingToken,
  { readonly brand: unique symbol }
>()("MissingToken", {
  message: Schema.String,
}) {}

const api = Effect.gen(function* () {
  const baseUrl = yield* Config.String("NOTES_URL").pipe(
    Config.withDefault("http://127.0.0.1:3000")
  );

  const token = yield* Config.Redacted("NOTES_TOKEN").pipe(
    Effect.mapError(
      () =>
        new MissingToken({
          message:
            "NOTES_TOKEN is not set. Set it to your token: export NOTES_TOKEN=<your token>",
        })
    )
  );

  return yield* ActionHttp.client(Http, {
    baseUrl,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(token)
    ),
  });
});

const escape = (body: string) => body.replaceAll(/^(?=\\*# )/gmu, "\\");

const unescape = (body: string) => body.replaceAll(/^\\(?=\\*# )/gmu, "");

const exportNotes = Command.make(
  "export",
  {
    file: Argument.String("file").pipe(
      Argument.withDescription("The Markdown file to write.")
    ),
  },
  ({ file }) =>
    Effect.gen(function* () {
      const client = yield* api;
      const files = yield* FileSystem.FileSystem;
      const { notes } = yield* client.listNotes();

      const whole = yield* Effect.forEach(notes, ({ id }) =>
        client.getNote({ id })
      );

      yield* files.writeFileString(
        file,
        whole
          .map((note) => `# ${note.title}\n\n${escape(note.body)}`)
          .join("\n\n")
      );

      yield* Console.log(`Wrote ${whole.length} notes to ${file}`);
    }).pipe(
      Effect.tapError(() =>
        Console.error(`The export to ${file} did not finish.`)
      ),
      ActionCli.toUserError(Http)
    )
).pipe(Command.withDescription("Write every note to a file, as Markdown."));

const importNotes = Command.make(
  "import",
  {
    text: Argument.FileText("file").pipe(
      Argument.withDescription("A Markdown file as `notes export` writes it.")
    ),
  },
  ({ text }) =>
    Effect.gen(function* () {
      const client = yield* api;

      if (text === "") {
        return yield* Console.log("Created 0 notes");
      }

      if (!text.startsWith("# ")) {
        return yield* new CliError.UserError({
          cause: text.split("\n", 1)[0],
          userMessage:
            "The file does not start with a `# ` title, as `notes export` writes one.",
        });
      }

      const notes = text.split(/\n\n(?=# )/u).map((note) => {
        const [title = "", ...body] = note.slice(2).split("\n\n");

        return { title, body: unescape(body.join("\n\n")) };
      });

      const { notes: created } = yield* client.importNotes({ notes });

      yield* Console.log(`Created ${created.length} notes`);
    }).pipe(ActionCli.toUserError(Http))
).pipe(
  Command.withDescription(
    "Create the notes of a file `export` wrote, all or none, at most 100."
  )
);

export const commands = ActionCli.remote(Http, {
  name: "notes",
  client: api,
  commands: {
    createNote: { stdin: "body" },
    getNote: {
      positional: ["id"],
      render: (note) => `# ${note.title}\n\n${note.body}`,
    },
    updateNote: { positional: ["id"], stdin: "body" },
  },
  subcommands: [exportNotes, importNotes],
});
