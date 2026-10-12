# ActionCli

Native Effect CLI commands for actions, with flags derived from each action's input. `make` and
`command` take implementations and run the handler in the command's own process, behind the same
`authorize`: for a local tool, or an operator console that has the services itself. `remote` and
`remoteCommand` take an HTTP binding and call a server, running nothing locally: for users of a
service you already serve. `make` and `remote` derive a command for every action of the
implementations or the binding, so a new action is a new command: list `actions` to leave some
out.

Read this page alone, in one tool call: pages read together are cut. When something fails,
search [ActionCli-failures.md](ActionCli-failures.md). Reading order: [README.md](README.md).

## API

Import `@gjermundgaraba/effect-actions/ActionCli`.

| API                                          | Purpose                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `make(implementations, options)`             | Every implemented action as a subcommand of one command, run in process. |
| `command(implementations, action, options?)` | One action, selected by its contract, as a native Effect `Command`.      |
| `remote(binding, options)`                   | Every action of an HTTP binding as a subcommand, called over HTTP.       |
| `remoteCommand(binding, action, options?)`   | One action of an HTTP binding, called over HTTP.                         |
| `toUserError(binding)`                       | Piped onto a command of your own: it fails as a derived command does.    |
| `logToStderr`                                | Applied last before `runMain`: stdout carries only results.              |

| Option                                   | Meaning                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `command`, `remoteCommand`: `name`       | The command's name; default: the action's in kebab case.                        |
| `command`, `remoteCommand`: `render`     | Decoded success to text for a person; adds `--json`.                            |
| `command`, `remoteCommand`: `positional` | Input fields taken as positional arguments instead of flags, in this order.     |
| `command`, `remoteCommand`: `aliases`    | A short flag per field: `{ limit: "n" }` takes `-n 5` beside `--limit 5`.       |
| `command`, `remoteCommand`: `stdin`      | A required field read from stdin instead of a flag: `{ stdin: "value" }`.       |
| `make`, `remote`: `name`                 | The aggregate's name, required.                                                 |
| `make`, `remote`: `actions`              | The actions that are subcommands; default: every one.                           |
| `make`, `remote`: `commands`             | Each subcommand's `command` options, by action name: `{ getNote: { render } }`. |
| `make`, `remote`: `subcommands`          | Commands of your own beside the derived ones: `[exportNotes]`.                  |
| `remoteCommand`, `remote`: `client`      | The `ActionHttp.client` options, `baseUrl` and `transformClient`.               |

Exported types: `Options<A>`, `RemoteOptions<A>`, `CommandOptions<A>`, `RemoteCommandOptions<A>`,
and `UserError<E>`, a type only: what a command fails with when its action fails with `E`.

## Run actions as local commands

Pass implementations to `make`, and provide the services and the caller on the command:

```ts
const assistant = ActionCli.make([tasks, identity], { name: "assistant" }).pipe(
  Command.provide(Layer.mergeAll(TaskStore.layerFile, Permissions.layerMemory)),
  Command.provideSync(CurrentCaller, operator),
);
```

Run it with Effect's own `Command.run`:
[assistant/src/commands.ts](../examples/assistant/src/commands.ts) and
[assistant/src/cli.ts](../examples/assistant/src/cli.ts) are the whole program, and
[kitchen-sink/src/ops.ts](../examples/kitchen-sink/src/ops.ts) an operator console.

- **Provide services on the command, not around the run.** `Command.provide(layer)` builds the
  layer when an action runs. Provided around `Command.run`, it is built before parsing, so
  `--help` and a mistyped flag open the database. The aggregate run with no subcommand still
  builds what it is provided before showing its help.
- **Each run builds its implementation.** A command runs its action's builder, and an authorizer
  an Effect builds, then releases them after the call, even where the host already built them.
  Implementations passed alongside are not built.
- **For one action, or a tree of your own**, use `command(implementations, action, options?)`
  under native `Command.withSubcommands`. For a command of your own beside every derived one:
  [Add a command of your own](#add-a-command-of-your-own).
- **Test commands without a process** with `Command.runWith`, `TestConsole` and
  `Stdio.layerTest`. Provide the services around the test so its commands share one store:
  [assistant/test/commands.test.ts](../examples/assistant/test/commands.test.ts).
  `TestConsole.logLines` holds every line of the test, each `unknown`, not of one run: take each
  run's own and compare or decode them, as
  [notes-service/test/commands.test.ts](../examples/notes-service/test/commands.test.ts) does.
  A run also fails with Effect CLI's own errors, such as a flag that does not parse: only a
  `UserError` has a `userMessage`, so match it (`Effect.catchTag("UserError", …)`) before reading one.

## Call a server from commands

Pass the HTTP binding to `remote`. The program imports the binding alone, never a handler; each
command calls its action through the binding's `ActionHttp.client` method
([ActionHttp.md](ActionHttp.md#call-the-api-from-effect)) and fails as that method does. The host
provides `HttpClient` (`NodeHttpClient.layerUndici`) and says where the server is:
[notes-service/src/commands.ts](../examples/notes-service/src/commands.ts) and
[notes-service/src/cli.ts](../examples/notes-service/src/cli.ts).
[kitchen-sink/src/cli.ts](../examples/kitchen-sink/src/cli.ts) adds a tenant header and uses
every command option.

- **Choose where the connection comes from.** A fixed URL or token goes in the `client` option:
  `client: { baseUrl, transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)) }`.
  One read from `Config` configures the `HttpClient` provided on the command, with
  `Command.provideEffect(HttpClient.HttpClient, …)` as `notes-service/src/cli.ts` does, so
  `--help` needs neither. A command of your own in `subcommands` calls through the same client.
- **Configure the client on the command, never around the program.** Around the program it
  rewrites every request the program makes, an absolute URL too, and sends each one the token.
- **A token every command needs is required, its failure mapped to a `CliError.UserError`**, or a
  missing one prints a raw `ConfigError` log line: `connection` in
  [notes-service/src/commands.ts](../examples/notes-service/src/commands.ts). Where a public
  command must answer signed out, read it with `Config.option` and add the header when it is
  there: [kitchen-sink/src/cli.ts](../examples/kitchen-sink/src/cli.ts).
- **Test a remote command the same way** as a local one, with `Testing.layer(routes)` provided
  as its `HttpClient` ([Testing.md](Testing.md#test-routes-in-memory)). Export the command from
  a module apart from the entrypoint that runs it
  ([notes-service/test/commands.test.ts](../examples/notes-service/test/commands.test.ts)).

## Shape flags, input and output

### Flags from the input

A struct or class input gets one flag per top-level field, named after the field in kebab case,
with the field's description as its help, annotated before or after its checks. The field's
encoded JSON value decides the kind of flag:

| Encoded field                            | Flag, for a field `tags`, `read`, …                             |
| ---------------------------------------- | --------------------------------------------------------------- |
| string or template literal               | `--name <string>`                                               |
| boolean                                  | `--read`, a switch: `--no-read` or `--read=false` sends `false` |
| union of string literals, or string enum | `--kind <choice>`, one of the values                            |
| array of strings, numbers or choices     | `--tags <value>`, repeated: one element per occurrence          |
| anything else, numbers included          | `--owner <value>`: JSON the field accepts, or else the text     |

- A switch left out is `false` for a required field, and leaves an optional one out.
- `--help` adds, after the field's description, `Repeat for each value.` on a repeated flag,
  `--no-read sends false.` on an optional switch, `Left out, it sends false.` on a required
  one, and `A JSON array.` or `A JSON object.` on a
  value that is one, an array of objects with its fields: `A JSON array of {id, approved?}.`
- A flag takes the encoded value, which the action's schema then decodes: `"21"` for
  `Schema.FiniteFromString`.
- A value flag reads its text as JSON when the field accepts that kind of JSON value
  (`--count 2`, `--owner '{"id":"x"}'`, `--points '[{"x":1}]'`), and keeps it as text otherwise
  (`--limit auto`).
- A repeated flag given no occurrence sends `[]` for a required `Schema.Array` field, and leaves
  an optional field out, where `--tags '[]'` alone sends an empty list.
- An input that is not a struct of named fields (a union, a record, a scalar) gets one
  `--input <value>` flag carrying the whole encoded input. Left off, the input is `{}`.

### Arguments, short flags and stdin

In an aggregate, a command's options go under `commands`, keyed by the action's name
(`completeTask`), not the command's:
[assistant/src/commands.ts](../examples/assistant/src/commands.ts).

- `positional`: list every required field before any optional one, and an array field last.
- `stdin` suits a secret or a document. The value is all of stdin until it closes, without the
  line endings that end it. A terminal is never read: pipe the value in.

### Add a command of your own

Work every surface should offer, a bulk import for one, is an action first: a command of your
own then only reads the file and calls it. For a syntax the options cannot express, such as a
flag named apart from its field, build the command with native `Command.make`, `Flag` and `Argument`, and
pass it in `subcommands`: `notes export <file>` takes `Argument.String("file")`
([notes-service/src/commands.ts](../examples/notes-service/src/commands.ts)):

```ts
const notes = ActionCli.remote(Http, { name: "notes", subcommands: [exportNotes] });
```

- **Never pipe `Command.withSubcommands` onto `make` or `remote`.** It replaces the derived
  commands, which then answer with the usage text.
- **Call the actions through a client**, in the command's own handler: `ActionHttp.client`, which
  needs no scope and uses the `HttpClient` provided on the aggregate, or `Action.client`, acquired
  inside `Effect.scoped` ([Action-in-process.md](Action-in-process.md#call-actions-in-process)).
  `authorize` still runs. The `client` option reaches the derived commands alone.
- **Its output is what it prints**, with `Console.log`: the output rules below are a derived
  command's. **Pipe its whole Effect through `ActionCli.toUserError(Http)`**, the binding its
  client is made from, HTTP or RPC, or `toUserError([GetNote])` over `Action.client`, to fail as a derived command does: a declared
  error as its JSON on stderr, a transport failure named with its causes. A message of your own is `new CliError.UserError({ cause, userMessage })`, which
  passes through. To add context to a failure, such as how far a batch got, print it inside the
  pipe, `Effect.tapError(() => Console.error(…))`: wrapping the `UserError` in another puts its
  JSON mid-sentence and hides the action's failure from `catchReason`. A failure left unmapped, one call's included, is reported as a crash,
  `ERROR (#n)` with a stack trace.
- **Write the list in the call**, or hold the options with `satisfies ActionCli.Options<…>`. The
  aggregate's type then carries its commands' failures and services. A list in options
  annotated `: ActionCli.Options<…>` adds none: the program compiles, then a command's service is not found.

### Output and exit code

- **A command writes only its result to stdout**: the success as JSON, indented by two spaces,
  or the text `render` returns.
- **Everything else a command runs writes to stderr**: its Effect logs and Effect `Console`
  output. The global `console.log` and other direct writes bypass Effect and still reach stdout.
- **A failure of the action is printed once on stderr, under Effect CLI's `ERROR` heading, as
  the JSON HTTP sends for it** ([guarantees.md](guarantees.md#wire-behavior)), on the last line:
  `{"_tag":"TaskNotFound","id":"9"}`. The process exits 1, or with the failure's
  `Runtime.errorExitCode`. A failure no schema encodes, a builder's or the transport's, prints
  as its tag or name and its message, never its other fields.
- **Apply `logToStderr` last, before `runMain`, when scripts read stdout.** What happens outside
  a command is `runMain`'s to report, on stdout: a defect, such as a handler's bug or a success
  that does not encode, and a failure or a log of a layer the host provides. `logToStderr` moves
  those reports and the default logger to stderr, keeping the exit code, but not those layers'
  `Console` output or a logger writing through `Console.log`, such as `Logger.consoleJson`: log
  JSON with `Logger.withConsoleError(Logger.formatJson)`.

### Handle a failure after `Command.run`

A command fails with `UserError<E>`, Effect CLI's `UserError` whose `cause`, and `reason`, is the
action's failure. Match it by its tag:
`Effect.catchReason("UserError", "TaskNotFound", (missing) => ...)`. `Command.run` has printed it
by then, so a recovery decides what follows, such as the exit code, not the text. For text of
your own, provide Effect's formatter,
`CliOutput.layer(Object.assign({}, CliOutput.defaultFormatter(), { formatError }))`, or pass
`renderErrors: false` to `Command.run` and print every failure yourself, the parser's too.

## Name the caller

A local command of a protected action requires the identity service its contract declares
([Action.md](Action.md#say-who-may-call-an-action)), whether or not a handler reads it. No
credential arrives at a terminal, so the host names the caller, on the command:
`Command.provideSync(CurrentCaller, operator)`, or `Command.provideEffect(CurrentCaller, load)`
to read it when an action runs. See [assistant/src/cli.ts](../examples/assistant/src/cli.ts).

- **A local command is no bypass.** The implementation's `authorize` runs as on every surface
  ([Action.md](Action.md#authorize-calls)).
- **A trusted operator is a type, not a flag.** Give the identity a variant only a host builds,
  kept out of every verifier's return type, and admit it in the shared `authorize`:
  [assistant/src/identity/Identity.ts](../examples/assistant/src/identity/Identity.ts) with
  [assistant/src/identity/authorize.ts](../examples/assistant/src/identity/authorize.ts), or
  [kitchen-sink/src/admin/Admin.ts](../examples/kitchen-sink/src/admin/Admin.ts) with
  [kitchen-sink/src/ops.ts](../examples/kitchen-sink/src/ops.ts).
- **A remote command names no caller.** The server verifies the credentials its client sends.
