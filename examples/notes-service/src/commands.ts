import { Console, Effect } from "effect";
import { Command } from "effect/cli";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./Api.js";

// A command of your own, for what no single action does: this one calls two. It is a native
// Effect CLI command, so its syntax and its output are what you write. It calls the server
// through the binding's typed client, on the `HttpClient` the derived commands use.
const exportNotes = Command.make("export", {}, () =>
  Effect.gen(function* () {
    const client = yield* ActionHttp.client(Http);
    const { notes } = yield* client.listNotes();
    const whole = yield* Effect.forEach(notes, ({ id }) => client.getNote({ id }));

    yield* Console.log(whole.map((note) => `# ${note.title}\n\n${note.body}`).join("\n\n"));
  }).pipe(
    // Once, around the whole command: it then fails as a derived command does, an action's
    // error printed as its JSON on stderr. A failure left as it is would be reported as a
    // crash, with an `ERROR (#n)` line and a stack trace.
    ActionCli.toUserError(Http.actions),
  ),
).pipe(Command.withDescription("Print every note, as Markdown."));

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
