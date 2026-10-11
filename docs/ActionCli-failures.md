# ActionCli failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [ActionCli.md](ActionCli.md).

## Flags and input

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

## Thrown when a command is built

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
  `claimed by action ... and subcommands`: a command of your own has a derived one's name. Rename
  either.
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

## Types

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
  identity on the command ([Name the caller](ActionCli.md#name-the-caller)); do not make the contract public
  to satisfy the requirement.
- Type error at `Effect.catchTag("UserNotFound", ...)` after `Command.run`: the command fails
  with `UserError`. Use `Effect.catchReason("UserError", "UserNotFound", ...)`.
- Type error at `Effect.catchReason("UserError", "<Tag>", ...)`, its tag typed `never`: a failure
  of the command has no `_tag`, such as a builder's plain `Error`. Fail with a tagged error, such
  as a `Schema.TaggedError` or `Data.TaggedError`.

## Running

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
