# ActionCli

Native Effect CLI commands for actions, with flags derived from each action's input. `make` and
`command` take implementations and run the handler in the command's own process, behind the same
`authorize`, whether or not a server serves the action. `remote` and `remoteCommand` take an HTTP
binding and call a server instead, running nothing locally. Use the first pair for a local tool
or an operator console that has the services itself, the second for users of a service you
already serve.

## API

Import `@gjermundgaraba/effect-actions/ActionCli`.

| API                                          | Purpose                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `make(implementations, options)`             | Every implemented action as a subcommand of one command, run in process. |
| `command(implementations, action, options?)` | One action, selected by its contract, as a native Effect `Command`.      |
| `remote(binding, options)`                   | Every action of an HTTP binding as a subcommand, called over HTTP.       |
| `remoteCommand(binding, action, options?)`   | One action of an HTTP binding, called over HTTP.                         |
| `logToStderr`                                | Applied last before `runMain`: stdout carries only results.              |

| Option                                   | Meaning                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `command`, `remoteCommand`: `name`       | Override the command name (default: the action name in kebab case).                                          |
| `command`, `remoteCommand`: `render`     | Decoded success to human-readable string; adds `--json`.                                                     |
| `command`, `remoteCommand`: `positional` | Input fields taken as positional arguments instead of flags, in this order.                                  |
| `command`, `remoteCommand`: `aliases`    | A short name per field's flag: `{ limit: "n" }` takes `-n 5` beside `--limit 5`.                             |
| `command`, `remoteCommand`: `stdin`      | A required field read from stdin instead of a flag: `{ stdin: "value" }`.                                    |
| `make`, `remote`: `name`                 | The aggregate's name, required.                                                                              |
| `make`, `remote`: `actions`              | The actions that are subcommands, among the implementations' or the binding's; defaults to every one.        |
| `make`, `remote`: `commands`             | Each subcommand's `command` options, keyed by action name: `{ readFile: { positional: ["path"], render } }`. |
| `remoteCommand`, `remote`: `client`      | The `ActionHttp.client` options, `baseUrl` and `transformClient`, for this command's or aggregate's client.  |

Exported types: `Options<A>` of `make`, `RemoteOptions<A>` of `remote`, `CommandOptions<A>` of
`command`, `RemoteCommandOptions<A>` of `remoteCommand`, and `UserError<E>`, a type only: what a
command fails with when its action fails with `E`.

## Run actions as local commands

Pass implementations to `make`, provide the services and the caller on the command, and run it
with Effect's own `Command.run`:

```ts
const assistant = ActionCli.make([tasks, identity], { name: "assistant" }).pipe(
  Command.provide(Layer.mergeAll(TaskStore.layerFile, Permissions.layerMemory)),
  Command.provideSync(CurrentCaller, operator),
);

Command.run(assistant, { version: "1.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
```

The whole program is [assistant/src/commands.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/commands.ts) and
[assistant/src/cli.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/cli.ts); an operator console is
[kitchen-sink/src/ops.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/ops.ts).

- **Provide services on the command, not around the run.** `Command.provide(layer)` builds the
  layer when an action runs. Provided around `Command.run`, it is built before parsing, so
  `--help` and a mistyped flag open the database. The aggregate run with no subcommand is the
  exception: it builds what it is provided before showing its help.
- **Each run builds its implementation.** A command runs the builder of its action's
  implementation, and an authorizer an Effect builds, then releases them after the call, even
  where the host already built them. Implementations passed alongside are not built.
- **For one action, or a tree of your own**, use `command(implementations, action, options?)`
  and compose with native combinators:
  `Command.make("acme").pipe(Command.withSubcommands([...]))`.
- **Test commands without a process** with `Command.runWith`, `TestConsole` and
  `Stdio.layerTest`. Provide the services around the test so its commands share one store:
  [assistant/test/commands.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/test/commands.test.ts).

## Call a server from commands

Pass the HTTP binding to `remote`. The program imports the binding alone, never a handler; each
command calls its action through the binding's `ActionHttp.client` method
([ActionHttp.md](ActionHttp.md#call-the-api-from-effect)) and fails as that method does. The host
provides `HttpClient` (`NodeHttpClient.layerUndici`) and says where the server is:

```ts
const notes = ActionCli.remote(Http, { name: "notes" }).pipe(
  Command.provideEffect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const url = yield* Config.String("NOTES_URL");
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
```

The whole program is [notes-service/src/cli.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/cli.ts);
[kitchen-sink/src/cli.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/cli.ts) adds a tenant header.

- **Choose where the connection comes from.** A fixed URL or token goes in the `client` option:
  `client: { baseUrl, transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)) }`.
  One read from `Config` configures the `HttpClient` provided on the command, as above, so
  `--help` needs neither.
- **Configure the client on the command, never around the program.** Around the program it
  rewrites every request the program makes, an absolute URL too, and sends each one the token.
  On the command, or in `client`, it reaches these commands' requests alone.
- **Read the token with `Config.option` when the binding has a public action.** A required
  token makes the public command fail without one. A protected command without a token gets the
  server's 401.
- Input is decoded by the action's schema first: input that does not decode is `InvalidInput`,
  and sends nothing.
- **Test a remote command the same way** as a local one, with `Testing.layer(routes)` provided
  as its `HttpClient` ([Testing.md](Testing.md#test-routes-in-memory)).

## Shape flags, input and output

### Flags from the input

A struct or class input gets one flag per top-level field, with the field's description as its
help. The field's encoded JSON value decides the kind of flag:

| Encoded field                            | Flag                                                        |
| ---------------------------------------- | ----------------------------------------------------------- |
| string or template literal               | `--name <string>`                                           |
| boolean                                  | `--on`, a switch; omitted is `false` for a required field   |
| union of string literals, or string enum | `--kind <choice>`, one of the values                        |
| array of strings, numbers or choices     | `--tag <value>`, repeated: one element per occurrence       |
| anything else, numbers included          | `--owner <value>`: JSON the field accepts, or else the text |

- A flag takes the encoded value, which the action's schema then decodes: `"21"` for
  `Schema.FiniteFromString`.
- A value flag reads its text as JSON when the field accepts that kind of JSON value
  (`--count 2`, `--owner '{"id":"x"}'`, `--points '[{"x":1}]'`), and keeps it as text otherwise
  (`--limit auto`).
- A repeated flag given no occurrence leaves an optional field out. `--tags '[]'` alone sends an
  empty list.
- An input that is not a struct of named fields (a union, a record, a scalar) gets one
  `--input <value>` flag carrying the whole encoded input. Left off, the input is `{}`.

### Arguments, short flags and stdin

In an aggregate, a command's options go under `commands`, keyed by the action's name
(`completeTask`), not the command's:
[assistant/src/commands.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/commands.ts).

- `positional`: list every required field before any optional one, and an array field last,
  since it takes every value left.
- `stdin` suits a secret or a document. The value is all of stdin until it closes, without the
  line endings that end it. A terminal is never read: pipe the value in.
- The options combine on one command: `updateNote: { positional: ["id"], stdin: "body" }` reads
  `notes update-note <id> --revision 1 < draft.md`
  ([notes-service/src/cli.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/cli.ts)).

For a syntax the options cannot express, such as a flag named apart from its field, or a command
calling several actions, build the command with native `Command.make`, `Flag` and `Argument`, and
call the actions through `Action.client`, acquired in the handler inside `Effect.scoped`
([Action.md](Action.md#call-actions-in-process)), or through `ActionHttp.client`. `authorize`
still runs, but the output and failure rules below do not apply: map a failure to Effect CLI's
`new CliError.UserError({ cause, userMessage })` for `Command.run` to print it on stderr.

### Output and exit code

- **A command writes only its result to stdout**: the success as JSON, or the text `render`
  returns. `render` receives the decoded success, an `Action.Image`'s `data` a `Uint8Array`, and
  returns text, never bytes.
- **Everything else a command runs writes to stderr**: the Effect logs and Effect `Console`
  output of the builder, authorizer, handler, client and codecs. The global `console.log` and
  other direct writes bypass Effect and still reach stdout.
- **A failure of the action is printed once on stderr, under Effect CLI's `ERROR` heading, as
  the JSON HTTP sends for it** ([guarantees.md](guarantees.md#wire-behavior)): the JSON is the
  last line, such as `{"_tag":"TaskNotFound","id":"9"}`. The process exits 1, or with the
  failure's `Runtime.errorExitCode`. A failure no schema
  encodes, a builder's or the transport's, prints as its tag or name and its message, never its
  other fields.
- **Apply `logToStderr` last, before `runMain`, when scripts read stdout.** What happens outside
  a command is `runMain`'s to report, on stdout: a defect, such as a handler's bug or a success
  that does not encode, and a failure or a log of a layer the host provides. `logToStderr` moves
  those reports and the default logger to stderr, and keeps the exit code. It does not move those
  layers' `Console` output, or a logger writing through `Console.log` such as
  `Logger.consoleJson`: log JSON with `Logger.withConsoleError(Logger.formatJson)`. An MCP
  subprocess applies it the same way ([ActionMcp.md](ActionMcp.md#serve-tools-over-stdio)).

### Handle a failure after `Command.run`

A command fails with `UserError<E>`, Effect CLI's `UserError` whose `cause`, and `reason`, is the
action's failure. Match it by its tag with Effect's own
`Effect.catchReason("UserError", "TaskNotFound", (missing) => ...)`. `Command.run` has printed it by then, so a recovery decides what follows, such as the
exit code, not the text. For text of your own, provide Effect's formatter,
`CliOutput.layer(Object.assign({}, CliOutput.defaultFormatter(), { formatError }))`, or pass
`renderErrors: false` to `Command.run` and print every failure yourself, the parser's too.

## Name the caller

A local command of a protected action requires the identity service its contract declares
([Action.md](Action.md#say-who-may-call-an-action)), whether or not a handler reads it. No
credential arrives at a terminal, so the host names the caller, on the command:
`Command.provideSync(CurrentCaller, operator)`, or `Command.provideEffect(CurrentCaller, load)`
to read it when an action runs. Request identity is supplied per call on every surface and is
never a startup service: here the host supplies it per run. See
[assistant/src/cli.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/cli.ts).

- **A local command is no bypass.** The implementation's `authorize` runs as on every surface
  ([Action.md](Action.md#authorize-calls)), and `ActionCli` takes no authorization of its own.
- **A trusted operator is a type, not a flag.** Give the identity a variant only a host builds,
  typed apart from what any verifier returns, and admit it in the shared `authorize`:
  [assistant/src/identity/Identity.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/identity/Identity.ts) with
  [assistant/src/identity/authorize.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/identity/authorize.ts), or
  [kitchen-sink/src/admin/Admin.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/admin/Admin.ts) with
  [kitchen-sink/src/ops.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/ops.ts). The library cannot tell which
  identities are trusted: keep the trusted variant out of every verifier's return type.
- **A remote command names no caller.** It sends the credentials its client carries, and the
  server verifies them.

## Examples

| File                                                                                   | Shows                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [notes-service/src/cli.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/cli.ts)                       | `remote`: URL and optional token from `Config`, `stdin`, `positional`, `render` |
| [assistant/src/commands.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/commands.ts)                     | `make`, with `aliases`, `render`, `positional` and `stdin`                      |
| [assistant/src/cli.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/cli.ts)                               | Services on the command, the host naming the caller, `logToStderr`              |
| [assistant/src/identity/authorize.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/src/identity/authorize.ts) | One `authorize` for a model's tool call and a command, admitting the operator   |
| [assistant/test/commands.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/test/commands.test.ts)         | Testing syntax and output with `Command.runWith`, stdin included                |
| [kitchen-sink/src/cli.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/cli.ts)                         | `remote` with every command option, `name` included; an image rendered as text  |
| [kitchen-sink/src/ops.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/ops.ts)                         | `make` as an operator console, run as a trusted identity no verifier returns    |

## Failure modes

### Flags and input

- `Missing required flag: --<flag>`, or `Missing required argument: <field>`, on stderr after
  the command's help: pass it. A positional field has no flag: `--<field>` is
  `Unrecognized flag: --<field> in command …`.
- `Invalid value for flag --<flag>: "<value>". Expected: ...`, or
  `Missing value for flag --<flag>`: the parser rejected a flag's text, a choice outside its
  values, or none. Effect's parser reads a value written apart from its flag as a flag itself
  when it starts with `-`, `-` alone and a number such as `-5` excepted: `--note -x` is a missing
  value and `Unrecognized flag: -x`, and `--note --help` prints help. Write `--<flag>=<value>`;
  `--` does not help, since what follows it is positional.
- `InvalidInput` naming an unexpected key: `--input` or a flag's JSON holds a field the schema
  does not declare, such as a misspelling.
- `InvalidInput` from a command whose input is not a struct, run without `--input`: the schema
  rejects the default `{}`. Pass `--input`.
- `InvalidInput` for a value that looks right: the flag takes the encoded value, or its text read
  as JSON of a kind the field also accepts. Quote a string that reads as JSON: `--id '"123"'` for
  a `String | Number` field. Malformed JSON is taken as text.
- `InvalidInput` whose issue says `<field> is read from stdin, which is a terminal: pipe it in`:
  nothing was piped in. `stdin cannot be read: <reason>` names a failed read.
- A command with a `stdin` field waits without output: nothing closes stdin, such as a parent
  process holding the pipe, or `ssh` run without `-n`. Pipe the value in, or redirect stdin from
  a file or `/dev/null`.

### Thrown when a command is built

The types refuse several of these first.

- `Duplicate positional argument: <field>`,
  `Required positional argument after an optional one: <field>` (reorder the list, or make the
  earlier field required), or `Repeated positional argument before another one: <field>` (list
  the array last).
- `Not an input field: <field>`, or `Positional arguments need named input fields` for an input
  that is not a struct.
- `Not a flag's input field: <field>`: an alias names a field that is positional, read from
  stdin, or no field. `Aliases need named input fields: <fields>`: the input is not a struct.
- `Not a required input field: <field>`: `stdin` names an optional field, or no field.
  `Both positional and stdin: <field>`. `Stdin needs named input fields: <field>`: the input is
  not a struct.
- `Duplicate flag: --<name>, claimed by ...`: two flags of one command share a name, such as two
  fields with one kebab-case name (`userId`, `user_id`), a `json` field beside `render`'s
  `--json`, or an alias another flag's name or alias takes. Rename the field or the alias, or
  drop `render`. A field named like a global flag (`help`, `version`, `log-level`) is not a
  clash: its flag shadows the global one on that command.
- `Duplicate command: <name>, claimed by action ... and action ...`: two actions of an aggregate
  have the same kebab-case name. Give one a `name` in `commands`, or use separate aggregates.
- `Unknown commands: <keys>`: a `commands` key names no action. Use the action's own name, not
  its kebab-case command name.
- `Listed in actions, but no implementation holds it: <names>`, or
  `but the binding does not hold it`: the listed actions are not the implementations' or the
  binding's, by identity. `(another contract)` marks one whose name they hold, as a second copy
  of the contracts module makes. List the contract they implement or bind.
- `Action "x" has no implementation here`, or a type error at `command`: no implementation passed
  has that contract. Pass the implementation, and select with the exact contract value it
  implements; an equal-looking action does not match.
- `Action "x" is implemented twice here`: more than one implementation passed implements the
  selected action. Pass one.
- `Action "x" is not in this HTTP binding`, or a type error at `remoteCommand`: the action was not
  passed to this binding's `ActionHttp.make`. Select with the exact contract value it received.

### Types

- An argument of type `Binding<…>` not assignable at `make` or `command`, or an implementation's
  at `remote` or `remoteCommand`: the local functions take implementations, the remote ones a
  binding. `client` at `make` or `command` is refused the same way. For a form chosen by a
  condition, build a command from each and choose between them:
  `remotely ? ActionCli.remote(Http, options) : ActionCli.make(users, options)`.
- `Object literal may only specify known properties, and 'status' does not exist in type …` at
  `make([...apps, status], { commands: { status: ... } })` in a helper generic over
  implementations, `<const Apps extends ReadonlyArray<Action.AnyImplementation>>`: through that
  constraint `commands` is typed for any action, and no entry for the helper's own action
  compiles. Give that action a command of its own and put both in a tree:
  `Command.make("x").pipe(Command.withSubcommands([ActionCli.make(apps, { name: "apps" }), ActionCli.command(status, Status, { render })]))`.
  `Command.withSubcommands` on `make`'s aggregate would replace its subcommands.
- `Type 'HttpClient' is not assignable to type 'never'` in the pipe that runs a remote command:
  provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`).
- A command requires an identity service no handler yields: the action is protected. Provide the
  identity on the command ([Name the caller](#name-the-caller)); do not make the contract public
  to satisfy the requirement.
- Type error at `Effect.catchTag("UserNotFound", ...)` after `Command.run`: the command fails
  with `UserError`. Use `Effect.catchReason("UserError", "UserNotFound", ...)`.
- Type error at `Effect.catchReason("UserError", "<Tag>", ...)`, its tag typed `never`: a failure
  of the command has no `_tag`, such as a builder's plain `Error`. Fail with a tagged error, such
  as a `Schema.TaggedError` or `Data.TaggedError`.

### Running

- Handler cannot find a service: provide its Layer on the command, `Command.provide(layer)`. The
  library supplies no service.
- `--help` or a mistyped flag connects to a database, or fails reading config: services are
  provided around the run, which builds them before parsing. Provide them on the command.
- `ERROR (#n): ConfigError: SchemaError(Expected string at ["NOTES_TOKEN"])` from a public
  command, exit 1, on stdout, or on stderr under `logToStderr`: the client provided on the
  command requires a token, and a failure of what a command is provided is `runMain`'s report,
  not the command's JSON. Read the token with `Config.option` and add the header only when it is
  there.
- `HttpClientError` whose `reason._tag` is `InvalidUrlError`: the command's client has no
  `baseUrl` and prepends no URL. Connection refused: the URL is wrong. 401 `Unauthenticated`: add
  credentials in `client`'s `transformClient` or on the client the command is provided; the
  command adds no headers of its own.
- Another command's request goes to the API's URL, or carries its token: the client is configured
  around the whole program. Configure it with `client`, or provide it on that command.
- A report with a stack on stdout, `ERROR (#1): ...`, instead of JSON on stderr: a defect, or a
  failure of a layer the host provides, which `runMain` reports. Fix the defect; apply
  `logToStderr` to keep such reports off stdout.
- The same report for a declared error, such as `UserNotFound`, from a command built with
  `Command.make`: the command calls `Action.client` or `ActionHttp.client` itself, and its
  failure is the action's own. Map it to `CliError.UserError`, or derive the command with
  `command`.
