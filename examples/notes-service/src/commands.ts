import { Config, Console, Effect, FileSystem, flow } from "effect";
import { Argument, CliError, Command } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./Api.js";

// A command of your own, for what no single action does: this one calls two and writes a file.
// It is a native Effect CLI command, so its syntax and its output are what you write: `notes
// export notes.md` takes its argument from `Argument`, as a flag would come from `Flag`. It
// calls the server through the binding's typed client, on the `HttpClient` the derived commands
// use, and writes with the `FileSystem` every Effect CLI command has.
const exportNotes = Command.make(
  "export",
  { file: Argument.String("file").pipe(Argument.withDescription("The Markdown file to write.")) },
  ({ file }) =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http);
      const files = yield* FileSystem.FileSystem;
      const { notes } = yield* client.listNotes();
      const whole = yield* Effect.forEach(notes, ({ id }) => client.getNote({ id }));

      yield* files.writeFileString(
        file,
        whole.map((note) => `# ${note.title}\n\n${note.body}`).join("\n\n"),
      );

      yield* Console.log(`Wrote ${whole.length} notes to ${file}`);
    }).pipe(
      // Context of your own for a failure goes to stderr before it, on a line of its own. A
      // `UserError` wrapped around the failure instead would put its JSON mid-sentence.
      Effect.tapError(() => Console.error(`Nothing was written to ${file}.`)),
      // Once, around the whole command: it then fails as a derived command does, an action's
      // error printed as its JSON on stderr and any other, a file that cannot be written for
      // one, named. A failure left as it is would be reported as a crash, with an `ERROR (#n)`
      // line and a stack trace.
      ActionCli.toUserError(Http),
    ),
).pipe(Command.withDescription("Write every note to a file, as Markdown."));

// A command per action of the binding, a flag per input field, each calling the server over
// HTTP. It imports the binding alone, never a handler. It is apart from cli.ts so a test runs
// it: test/commands.test.ts.
export const commands = ActionCli.remote(Http, {
  name: "notes",
  commands: {
    // `notes create-note --title Draft < draft.md`: the body is piped in, not a flag.
    createNote: { stdin: "body" },
    getNote: { positional: ["id"], render: (note) => `# ${note.title}\n\n${note.body}` },
    // `notes update-note <id> --revision 1 < draft.md`: an argument, a flag and stdin together.
    updateNote: { positional: ["id"], stdin: "body" },
  },
  // `Command.withSubcommands` on the result would replace the derived commands, so your own
  // go here.
  subcommands: [exportNotes],
});

// Where the server is and who is calling, read from config: the `HttpClient` every command
// above calls with. It is an Effect, not a value, so that cli.ts provides it on the commands
// and it runs when one of them does.
export const connection = Effect.gen(function* () {
  const url = yield* Config.String("NOTES_URL").pipe(Config.withDefault("http://127.0.0.1:3000"));

  // Required, since every command but `get-status` is refused without one. A failure of what a
  // command is provided is no action's error: left as it is, a missing token is reported as a
  // crash, the log line `ERROR (#n): ConfigError: SchemaError(Expected string at
  // ["NOTES_TOKEN"])`. Mapped to a `UserError`, it is printed as any failure of a command is:
  // the message under an `ERROR` heading on stderr, and exit 1. Only this read is mapped, so
  // the message is true of every failure it covers. A CLI whose public commands must answer
  // signed out reads the token with `Config.option` instead and adds the header when it is there.
  const token = yield* Config.Redacted("NOTES_TOKEN").pipe(
    Effect.mapError(
      (cause) =>
        new CliError.UserError({
          cause,
          userMessage: "NOTES_TOKEN is not set. Set it to your token: export NOTES_TOKEN=ada",
        }),
    ),
  );

  return HttpClient.mapRequest(
    yield* HttpClient.HttpClient,
    flow(HttpClientRequest.prependUrl(url), HttpClientRequest.bearerToken(token)),
  );
});
