# ActionCli failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [ActionCli.md](ActionCli.md).

## Flags and input

- `Unrecognized flag: --<field> in command …` for an input field: a field listed in `positional`
  has no flag. Pass its value as an argument.
- `Missing value for flag --<flag>`, or `Unrecognized flag: -x`, for a value starting with `-`:
  Effect's parser reads a value written apart from its flag as a flag itself when it starts with
  `-`, `-` alone and a number such as `-5` excepted: `--note -x` is a missing value, and
  `--note --help` prints help. Write `--<flag>=<value>`; `--` does not help, since what follows
  it is positional.
- `InvalidInput` naming an unexpected key: `--input` or a flag's JSON holds a field the schema
  does not declare, such as a misspelling.
- `InvalidInput` from a command whose input is not a struct, run without `--input`: the schema
  rejects the default `{}`. Pass `--input`.
- `InvalidInput` for a flag's value that looks right: a flag takes the encoded value, and reads
  its text as JSON when the field accepts that kind of JSON value. Quote a string that reads as
  JSON: `--id '"123"'` for a `String | Number` field. Malformed JSON is taken as text.
- A command with a `stdin` field waits without output: nothing closes stdin, such as a parent
  process holding the pipe, or `ssh` run without `-n`. Pipe the value in, or redirect stdin from
  a file or `/dev/null`.

## Thrown when a command is built

- `Required positional argument after an optional one: <field>`, or
  `Repeated positional argument before another one: <field>`: `positional` lists every required
  field before any optional one, and an array field last.
- `Not an input field: <field>`: `positional` names no field of the input.
- `Not a flag's input field: <field>`: an `aliases` key names a field that is positional, read
  from stdin, or no field.
- `Not a required input field: <field>`: `stdin` names an optional field, or no field.
- `Positional arguments need named input fields`, `Aliases need named input fields: <fields>`, or
  `Stdin needs named input fields: <field>`: the action's input is not a struct.
- `Duplicate flag: --<name>, claimed by ...`: two flags of one command share a name, such as two
  fields with one kebab-case name (`userId`, `user_id`), a `json` field beside `render`'s
  `--json`, or an alias another flag's name or alias takes. Rename the field or the alias, or
  drop `render`. A field named like a global flag (`help`, `version`, `log-level`) is not a
  clash: its flag shadows the global one on that command.
- `Duplicate command: <name>, claimed by action ... and action ...`: two actions of an aggregate
  have the same kebab-case name. Give one a `name` in `commands`, or use separate aggregates.
- `Duplicate command: <name>, claimed by action ... and subcommands`: a command passed in
  `subcommands` has a derived command's name. Rename either.
- `Unknown commands: <keys>`: a `commands` key names no action. Use the action's own name, not
  its kebab-case command name.
- `Listed in actions, but no implementation holds it: <names>`, or
  `but the binding does not hold it`: `actions` lists a contract that the implementations, or the
  binding, do not hold, by identity. `(another contract)` marks one whose name they hold, as a
  second copy of the contracts module makes. List the contract they implement or bind.
- `Action "x" has no implementation here`, or a type error at `command`: no implementation passed
  has that contract. Pass the implementation, and select with the exact contract value it
  implements; an equal-looking action does not match.
- `Action "x" is not in this HTTP binding`, or a type error at `remoteCommand`: the action was not
  passed to this binding's `ActionHttp.make`. Select with the exact contract value it received.

## Types

- An argument of type `Binding<…>` not assignable at `make` or `command`, an implementation not
  assignable at `remote` or `remoteCommand`, or `client` refused at `make` or `command`: `make`
  and `command` take implementations; `remote` and `remoteCommand` take a binding, and alone take
  `client`. To choose by a condition, build a command from each:
  `remotely ? ActionCli.remote(Http, options) : ActionCli.make(users, options)`.
- `Type 'HttpClient' is not assignable to type 'never'` in the pipe that runs a remote command:
  provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`).
- A local command requires an identity service no handler yields: its action is protected, and
  requires the identity its contract declares. Provide it on the command
  ([Name the caller](ActionCli.md#name-the-caller)); do not make the contract public to satisfy
  the requirement.
- Type error at `Effect.catchTag("UserNotFound", ...)` after `Command.run`: a command fails with
  `UserError`. Use `Effect.catchReason("UserError", "UserNotFound", ...)`.
- Type error at `Effect.catchReason("UserError", "<Tag>", ...)`, its tag typed `never`: a failure
  of the command has no `_tag`, such as a builder's plain `Error`. Fail with a tagged error, such
  as a `Schema.TaggedError` or `Data.TaggedError`.

## Running

- `--help` or a mistyped flag connects to a database, or fails reading config: services provided
  around `Command.run` are built before parsing. Provide them on the command,
  `Command.provide(layer)`.
- `ERROR (#n): ConfigError: SchemaError(Expected string at ["NOTES_TOKEN"])` from a public
  command, exit 1, on stdout, or on stderr under `logToStderr`: the client provided on the
  command requires a token, and a failure of what a command is provided is `runMain`'s report,
  not the command's JSON. Read the token with `Config.option` and add the header only when it is
  there. Where every command needs it, keep it required and map the failure, in the Effect that
  provides the client, to `new CliError.UserError({ cause, userMessage })`:
  [notes-service/src/commands.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/commands.ts).
- `HttpClientError` whose `reason._tag` is `InvalidUrlError`, from a remote command: its client
  has no `baseUrl` and prepends no URL.
- 401 `Unauthenticated` from a remote command: a remote command adds no headers of its own. Add
  credentials in `client`'s `transformClient`, or on the `HttpClient` the command is provided.
- Another command's request goes to the API's URL, or carries its token: an `HttpClient`
  configured around the whole program rewrites every request the program makes. Configure it in
  the `client` option, or provide it on the remote command alone.
- A report with a stack on stdout, `ERROR (#1): ...`, instead of JSON on stderr: a defect, or a
  failure of a layer the host provides, which `runMain` reports. Fix the defect; apply
  `ActionCli.logToStderr` to keep such reports off stdout.
- `ERROR (#n)` with a stack for a declared error, such as `UserNotFound`, from a command built
  with `Command.make`: a command of your own that calls `Action.client` or `ActionHttp.client`
  fails with the action's own error. Pipe the command's whole Effect through
  `ActionCli.toUserError`, given the binding or the actions it calls, or derive the command with `ActionCli.command`.
- `Argument of type 'string | undefined' is not assignable` at a `UserError`'s `userMessage`: it
  is optional on the type. Read it with `?? ""`, or assert it with `toHaveProperty`.
