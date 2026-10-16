import { Config, Console, Effect, FileSystem, Schema } from "effect";
import { Argument, CliError, Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./Api.js";

// What a command fails with when no token is configured: a tagged error of the CLI's own, printed
// on stderr as `MissingToken: <message>` under an `ERROR` heading, and exit 1.
class MissingToken extends Schema.TaggedError<MissingToken>()("MissingToken", {
  message: Schema.String,
}) {}

// The binding's typed client, connected to where the server is and as who is calling, both read
// from config. It is an Effect, not a client: every command here, the derived ones and your own,
// runs it when it runs, so `--help` and a mistyped flag read nothing. It reaches these commands'
// requests and no others.
const api = Effect.gen(function* () {
  const baseUrl = yield* Config.String("NOTES_URL").pipe(
    Config.withDefault("http://127.0.0.1:3000"),
  );

  // Required, since every command but `get-status` is refused without one. Left as it is, a
  // missing token prints as `ConfigError: …`; mapped, it prints the message, which says what to
  // do. A CLI whose public commands must answer signed out reads the token with `Config.option`
  // instead and adds the header when it is there.
  const token = yield* Config.Redacted("NOTES_TOKEN").pipe(
    Effect.mapError(
      () =>
        new MissingToken({
          message: "NOTES_TOKEN is not set. Set it to your token: export NOTES_TOKEN=<your token>",
        }),
    ),
  );

  return yield* ActionHttp.client(Http, {
    baseUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
  });
});

// The file's format: each note a `# ` title line, a blank line and its body, the notes apart by
// a blank line. A body line that starts as a title would is written with a backslash before it,
// as Markdown escapes one, and `import` takes it off, so every note reads back as it was.
const escape = (body: string) => body.replaceAll(/^(?=\\*# )/gmu, "\\");

const unescape = (body: string) => body.replaceAll(/^\\(?=\\*# )/gmu, "");

// A command of your own, for what no single action does: this one calls two and writes a file.
// It is a native Effect CLI command, so its syntax and its output are what you write: `notes
// export notes.md` takes its argument from `Argument`, as a flag would come from `Flag`. It
// calls the server through `api`, the client the derived commands call, and writes with the
// `FileSystem` every Effect CLI command has.
const exportNotes = Command.make(
  "export",
  { file: Argument.String("file").pipe(Argument.withDescription("The Markdown file to write.")) },
  ({ file }) =>
    Effect.gen(function* () {
      const client = yield* api;
      const files = yield* FileSystem.FileSystem;
      const { notes } = yield* client.listNotes();
      const whole = yield* Effect.forEach(notes, ({ id }) => client.getNote({ id }));

      yield* files.writeFileString(
        file,
        whole.map((note) => `# ${note.title}\n\n${escape(note.body)}`).join("\n\n"),
      );

      yield* Console.log(`Wrote ${whole.length} notes to ${file}`);
    }).pipe(
      // Context of your own for a failure goes to stderr before it, on a line of its own. A
      // `UserError` wrapped around the failure instead would put its JSON mid-sentence. The
      // line prints for every failure of the command, a file that cannot be written included,
      // so it says only what is true of them all.
      Effect.tapError(() => Console.error(`The export to ${file} did not finish.`)),
      // Once, around the whole command: it then fails as a derived command does, an action's
      // error printed as its JSON on stderr and any other, a file that cannot be written for
      // one, named. A failure left as it is would be reported as a crash, with an `ERROR (#n)`
      // line and a stack trace.
      ActionCli.toUserError(Http),
    ),
).pipe(Command.withDescription("Write every note to a file, as Markdown."));

// The other half of `export`: it reads such a file and creates its notes with one call of the
// bulk action, so the server checks every note before it writes any, and a file of more than
// the action's 100 is refused whole. The command reads the file and nothing more.
// `Argument.FileText` reads it, and a missing file is a usage error naming it, where
// `Argument.String` and `FileSystem` would print the platform's error. Text before the first
// title is refused, not dropped: the file is not one `export` wrote. The derived `import-notes`
// stays beside it, taking the notes as a JSON array in `--notes`.
const importNotes = Command.make(
  "import",
  {
    text: Argument.FileText("file").pipe(
      Argument.withDescription("A Markdown file as `notes export` writes it."),
    ),
  },
  ({ text }) =>
    Effect.gen(function* () {
      const client = yield* api;

      if (text === "") return yield* Console.log("Created 0 notes");

      if (!text.startsWith("# ")) {
        return yield* new CliError.UserError({
          cause: text.split("\n", 1)[0],
          userMessage: "The file does not start with a `# ` title, as `notes export` writes one.",
        });
      }

      const notes = text.split(/\n\n(?=# )/u).map((note) => {
        const [title = "", ...body] = note.slice(2).split("\n\n");

        return { title, body: unescape(body.join("\n\n")) };
      });

      const { notes: created } = yield* client.importNotes({ notes });

      yield* Console.log(`Created ${created.length} notes`);
    }).pipe(ActionCli.toUserError(Http)),
).pipe(
  Command.withDescription("Create the notes of a file `export` wrote, all or none, at most 100."),
);

// A command per action of the binding, a flag per input field, each calling the server over
// HTTP. It imports the binding alone, never a handler. It is apart from cli.ts so a test runs
// it: test/commands.test.ts.
export const commands = ActionCli.remote(Http, {
  name: "notes",
  client: api,
  commands: {
    // `notes create-note --title Draft < draft.md`: the body is piped in, not a flag.
    createNote: { stdin: "body" },
    getNote: { positional: ["id"], render: (note) => `# ${note.title}\n\n${note.body}` },
    // `notes update-note <id> --revision 1 < draft.md`: an argument, a flag and stdin together.
    updateNote: { positional: ["id"], stdin: "body" },
  },
  // `Command.withSubcommands` on the result would replace the derived commands, so your own
  // go here.
  subcommands: [exportNotes, importNotes],
});
