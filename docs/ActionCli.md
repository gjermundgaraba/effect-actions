# ActionCli

Native Effect CLI commands for actions, with flags derived from each action's input. From
implementations, a command runs the handler in process, with every service the host's; any
implemented action runs locally, whether or not HTTP or MCP serves it. From an HTTP binding,
a command calls the action over HTTP through its `ActionHttp.client` method instead, and runs
nothing locally.

## API

Import `@gjermundgaraba/effect-actions/ActionCli`.

| API                                          | Purpose                                                             |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `command(implementations, action, options?)` | One action, selected by its contract, as a native Effect `Command`. |
| `command(http, action, options?)`            | One action of an HTTP binding, called over HTTP.                    |
| `make(implementations, options)`             | Every implemented action as a subcommand of one aggregate command.  |
| `make(http, options)`                        | Every action of the binding as a subcommand, called over HTTP.      |

| Option                  | Meaning                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `command`: `name`       | Override the command name (default: the action name in kebab case).                                          |
| `command`: `render`     | Decoded success to human-readable string; adds `--json`.                                                     |
| `command`: `positional` | Input fields taken as positional arguments instead of flags, in this order.                                  |
| `make`: `name`          | The aggregate's name, required.                                                                              |
| `make`: `commands`      | Each subcommand's `command` options, keyed by action name: `{ readFile: { positional: ["path"], render } }`. |

Exported types: `Options<Actions>` of `make` and `CommandOptions<typeof Action>` of `command`, the same locally and over HTTP, and `Failure<E>`, a type only: what a command fails with when its action fails, Effect CLI's `CliError.UserError` whose `cause` is the failure `E`. A command over HTTP calls through the host's `HttpClient`, which sets where it sends and any credentials.

Flags come from the action's input. A struct or class input gets one flag per top-level
field, named in kebab case (`tenantId` is `--tenant-id`, `getHTTPUser` is `get-http-user`, `_id` is `--id`), parsing the field's encoded JSON
value:

| Encoded field                            | Flag                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| string or template literal               | `--name <string>`; the action's schema checks a template  |
| boolean                                  | `--on`, a switch; omitted is `false` for a required field |
| union of string literals, or string enum | `--kind <choice>`, one of the values                      |
| anything else, numbers included          | `--tags <value>`: JSON the field accepts, or the text     |

An input that is not a struct of named fields (a union, a record, a scalar) gets one
`--input <value>` flag carrying the whole encoded input. Left off, the input is `{}`, which the
action's schema decodes when the command runs. A schema accepting `{}`, including a union
with such a member, succeeds; otherwise the command fails with `InvalidInput`. An action without input gets no flags.
A value flag parses its text as JSON when the field's encoding accepts that kind of value
(`--count 2`, `--tags '["x"]'`), or else keeps the text (`--limit auto`, `--scale Infinity`
for `Schema.Number`, `--mode true` for `"auto" | string`); the action's schema decodes either.
Only the kind decides: JSON breaking a rule, such as four tags where three are allowed, stays
JSON, and the schema reports the rule and its path.
Choices may be nested unions: `Schema.Union([Schema.Literals(["a", "b"]), Schema.Literal("c")])`
is one choice of three.
A field's description is its flag's help text, whatever its encoding, except in a struct that
`Schema.encodeKeys` renames: its flags go by the encoded names and are described by the encoded
fields, so a transformed field there has no help text, as JSON Schema drops it. An optional field's
flag is optional and takes its value without the `null` that `Schema.optional` encodes
(`--name x` for `Schema.optional(Schema.String)`); a required `Schema.NullOr` field takes a value (`--name x`, `--name null`).
An optional field whose own schema encodes `null` takes it too: `--note null` is `Option.none()`
for `Schema.optionalKey(Schema.OptionFromNullOr(Schema.String))`, renamed or not.

A field listed in `positional` is an argument instead of a flag, parsed as its flag would
be, a boolean taking `true` or `false`: `command(implementations, Inspect, { positional: ["path"] })`
reads `inspect README.md --lines 10`. Arguments are read in the listed order, not the
input's. An optional field's argument is optional.

A local command requires what its handler, builder and hook require, and the invocation owns
its scope. Its `Failure`'s cause is what the action, the hook or the builder fails with, or a
built-in error. A command over HTTP requires an `HttpClient` supplied by the host, and its
cause is exactly what the action's `ActionHttp.client` method fails with. A command prints
only the encoded success on stdout; `Command.run` prints a failure on stderr.

## Canonical

```ts
import { Effect } from "effect";
import { Command } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { actors, CurrentActor } from "./authorization.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

// `users get-user --id 1`: a subcommand per action, a flag per input field. The
// implementation's hook runs here as on the servers; a local caller is not trusted more.
const cli = ActionCli.make(userActions, { name: "users" }).pipe(
  // Services go on the command: built when an action runs, never for `--help` or a
  // mistyped flag.
  Command.provide(Users.layerMemory),
  // No remote caller to authenticate: the host supplies the identity the hook reads.
  Command.provideSync(CurrentActor, actors.alice),
);

// Effect's own runner: the result goes to stdout, and a failure to stderr as the JSON HTTP
// sends, such as `{"_tag":"UserNotFound","id":"9"}`, exiting 1.
Command.run(cli, { version: "0.1.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
```

### Over HTTP

```ts
import { Command } from "effect/cli";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { Http } from "./binding.js";
import { Status } from "./contracts.js";

// From a binding rather than an implementation, the command calls the server instead.
const command = ActionCli.command(Http, Status).pipe(
  // Its client is the connection: where it sends, and any credentials. Provided on the
  // command, it reaches no other request the program makes.
  Command.provideEffect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.mapRequest(HttpClientRequest.prependUrl("http://127.0.0.1:3000")),
    ),
  ),
);

Command.run(command, { version: "0.1.0" }).pipe(
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
```

Credentials go on the same client, read when a command runs, as from `Config`. An aggregate
nests in the host's own tree like any native command, and what it is provided reaches its own
commands alone:

```ts
const api = ActionCli.make(Http, { name: "api" }).pipe(
  Command.provideEffect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const url = yield* Config.String("ACME_URL");
      const token = yield* Config.Redacted("ACME_TOKEN");

      return HttpClient.mapRequest(
        yield* HttpClient.HttpClient,
        flow(HttpClientRequest.prependUrl(url), HttpClientRequest.bearerToken(token)),
      );
    }),
  ),
);

// `acme api get-user --id 1` sends the token; the host's own `login` keeps its plain client.
const cli = Command.make("acme").pipe(Command.withSubcommands([api, login]));
```

## Rules

- `command(implementations, action)` selects the implementation of `action` among `implementations` (one implementation or a list) by contract identity, not by name: two contracts that share a name select their own implementations. The action must be one of the implementations' actions: the types refuse an action of another shape, and the runtime check refuses an equal-looking one.
- `make(implementations, { name })` puts every implemented action under one command named `name`, one subcommand per action, named after it in kebab case (`getUser` is `get-user`). `commands` gives one subcommand the options `command` takes, by its action's name, typed by that action; a key no action names is refused. That includes actions no HTTP binding or MCP endpoint serves. Subcommand names must be distinct after kebab-casing; two actions whose names collide are refused.
- Flags are values in their encoded form: `double --value 21` for a `FiniteFromString` field, which is string-encoded; a value flag takes the encoded JSON, or text. The action's schema then decodes the assembled input before dispatch.
- A field that is required once encoded has a required flag. Omitted, the parser refuses the command with `Missing required flag: --<flag>` and shows its help, and the implementation is not built. A required boolean is the exception: omitted, its switch is `false`.
- An optional field's flag is optional. Omitting it leaves the field out, including a field with a decoding default. The action's schema then decodes what the flags parsed, so transforms and cross-field rules still apply.
- `positional` names fields of a struct or class input, and the types offer none for any other input, a union included. Each is listed once, and every required field before any optional one, since a parser reads arguments in order. Remote commands take it too.
- The flags follow the schema: renaming a field renames its flag. `name`, `positional` and `render` give a command its name, its arguments and its output, and keep every rule of this page: prefer a derived command wherever they express the syntax. For a syntax they cannot, such as a flag named apart from its field, or a command calling several actions, build the command with native `Command.make`, `Flag` and `Argument`, and call the actions in it through `Action.client`, acquired in its handler, inside `Effect.scoped`, so each invocation builds and releases it ([Action.md](Action.md#clients)), or over HTTP through the binding's `ActionHttp.client`. Calling a handler directly bypasses decoding and the implementation's hook.
- Such a command is the host's own: through `Action.client` the hook and every check run, but the output, failure and logging rules of this page do not apply. It prints what it prints, its logs go where the host's logger writes, and a failure it leaves as it is is the action's own, not a `Failure`, which `runMain` reports on stdout with a stack and without its fields. Map it to Effect CLI's `CliError.UserError`, `new CliError.UserError({ cause, userMessage })`, for `Command.run` to print `userMessage` on stderr.
- Output is validated and encoded before printing. Default output is JSON. `render(decoded)` gives human output and adds a `--json` flag to that command, which selects JSON again. An action whose `success` is `Schema.Void` prints nothing by default or with `--json`; a custom `render` can still print human output. Rendering cannot bypass validation: a success its schema does not encode is a defect, as on HTTP, and nothing prints it.
- `--json` is a regular flag of the rendered command only. A command without `render` has no such flag: its output is JSON already. Nothing is declared tree-wide, so a host CLI may declare its own `--json`, global or not.
- Each invocation builds the selected implementation's builder, and its hook when an Effect builds it, in a scope of its own and releases them after the call. Only that implementation's builder runs: other implementations passed alongside it, on `command` or `make`, are not built. Domain services and authority come from layers the host provides on the command, `Command.provide(layer)`: built when the command runs, before its input is decoded, so input the action's schema refuses is refused after they are built; `--help` and the parser's errors, such as a missing or unknown flag, never build them. `make`'s aggregate run alone builds them before showing its help, since its own handler shows it, and fails instead if one fails. There is no HTTP fallback.
- A local command is a local surface: the implementation's `before` runs before the selected handler, on `command` and on every subcommand of `make`, and the host provides the identity the hook reads on the command, `Command.provideSync(CurrentActor, actor)`, or `Command.provideEffect(CurrentActor, load)` to read it when an action runs. A CLI is not a trusted bypass; a trusted admin CLI serves the same handlers under a hook of its own, `Action.share(actions, users, trustAdmin)` ([Action.md](Action.md#implementations)).
- A command writes only its result to stdout: the builder, hook and handler, or the client, and the codecs of its input, success and failures, write their Effect logs and Effect `Console` output to stderr, whatever logger prints them. The global `console.log` and other direct writes bypass Effect and still reach stdout: keep them off stdout.
- When its action fails, a command fails with Effect CLI's `UserError`, typed `Failure<E>`, whose `cause` is that failure: a declared error, a binding's, a built-in one, or a builder's. Its message is the JSON HTTP sends for it ([guarantees.md](guarantees.md#wire-behavior)), such as `{"_tag":"UserNotFound","id":"9"}`. `Command.run` prints it on stderr through Effect's `CliOutput` formatter and marks it reported, so `NodeRuntime.runMain` prints it no more, and the process exits 1, or with the cause's `Runtime.errorExitCode`. A failure no schema encodes, a builder's or the transport's, prints as its tag, or an error's name, and its message, then each cause's, up to one already printed, and never its other fields, a plain object's `name` among them.
- Every local command may fail with `Action.BuiltIn`, whatever its implementation's hook. Input that does not decode is `InvalidInput`, as over HTTP: it skips the hook and handler.
- After `Command.run` the failure may be any `UserError`, so a host matches the action's by its cause, after `Command.run` has printed it: `Effect.catchTag("UserError", (error) => error.cause instanceof UserNotFound ? ... : Effect.fail(error))` decides what follows, such as the exit code, not what was printed. `Failure` is a type only, since `instanceof` would leave its cause `any`. For text of its own, the host provides Effect's formatter, `CliOutput.layer(Object.assign({}, CliOutput.defaultFormatter(), { formatError }))`; `Command.run(cli, { version, renderErrors: false })` has it print every failure itself, the parser's too.
- `runMain` reports what is not a command's failure, outside the program, on stdout: a defect, such as a handler's bug or a success that does not encode, and a failure of a layer the host provides, on the command or around the run. Those layers log outside the command too. A CLI whose stdout feeds scripts sends both to stderr: it provides `Logger.LogToStderr` outermost, runs `NodeRuntime.runMain({ disableErrorReporting: true })`, and reports what the command did not print itself, `Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause)) ? Effect.void : Effect.logError(cause))`. `LogToStderr` moves the default logger, but not those layers' `Console` output or a logger writing through `Console.log`, such as `Logger.consoleJson`: log JSON with `Logger.withConsoleError(Logger.formatJson)`.
- From a binding, `command(http, action)` takes one of the binding's actions, matched by object identity at runtime, and calls its route, `<prefix>/<action>`, through the action's `ActionHttp.client` method. `make(http, { name })` projects every action of the binding, the same tree `make` builds locally, with the same options.
- A command over HTTP runs no hook: the server owns authentication and authorization. The host provides `HttpClient` and configures it on the remote command or aggregate, `Command.provideEffect(HttpClient.HttpClient, ...)`: where it sends, `HttpClient.mapRequest(HttpClientRequest.prependUrl(url))`, and credentials, `HttpClientRequest.bearerToken(token)`, read when a command runs. Configured around the whole program, it would rewrite every request the program makes, an absolute URL too, and send each the credentials. Nothing is inferred from action arguments.
- Over HTTP, input is decoded by the action schema before dispatch, then passed to the native client at its normal codec boundary. A failure's cause is the client's: the action's and binding's declared errors, the built-in errors ([guarantees.md](guarantees.md#wire-behavior)), `SchemaError` for an answer that does not decode, and `HttpClientError`. Input that does not decode is `InvalidInput`, and sends nothing.
- For a custom tree, compose individual `command` results with native `Command` combinators (`Command.make(name).pipe(Command.withSubcommands([...]))`). `make`'s aggregate nests in a host's tree the same way, and what it is provided reaches its own subcommands alone.

## Failure modes

- `Missing required flag: --<flag>` on stderr, after the command's help on stdout, from a native `CliError.ShowHelp` containing `MissingOption`: a required field's flag was not given. Pass it.
- `InvalidInput` naming an unexpected key: `--input` or a flag's JSON holds a field the schema does not declare, such as a misspelling. Undeclared fields are refused, never dropped.
- `InvalidInput` from a command whose input is not a struct, run without `--input`: the schema rejects the default `{}`. Pass `--input` with a value the schema accepts.
- `InvalidInput` for a value that looks right: the flag takes the encoded value, such as `"21"` for `FiniteFromString`. For `--input` or a value flag, the JSON or text may not be the field's encoding; malformed JSON is taken as text. Quote a string that reads as JSON: `--id '"123"'` for a `String | Number` field.
- `Invalid value for flag --<flag>: "<value>". Expected: ...`, or `Missing value for flag --<flag>`, from a native `CliError.ShowHelp` containing `InvalidValue`: the parser rejected a flag's text before the command ran: a choice outside its values, or none.
- `Missing required argument: <field>`, from a native `CliError.ShowHelp` containing `MissingArgument`: a required positional argument was not given. A positional field has no flag, so `--<field>` does not supply it.
- Thrown by `command` when the command is built: `Duplicate positional argument: <field>` (listed twice), or `Required positional argument after an optional one: <field>` (reorder the list, or make the earlier field required).
- Also thrown by `command`, and refused by the types first: `Not an input field: <field>`, or `Positional arguments need named input fields` for an input that is not a struct.
- `Duplicate flag: --<name>, claimed by ...` thrown by `command` or `make`: two flags of one command share a name. Examples are two input fields with the same kebab-case name (`userId`, `user_id`), or a `json` field beside `render`'s `--json`. Rename the field, or drop `render`.
- A field named like a global flag (`help`, `version`, `log-level`) is not a clash: its flag shadows the global one on that command.
- Type error at `command`, or `Action "x" has no implementation here` thrown: the action is not the contract of any implementation in `implementations`. Pass the implementation too, and select with the exact contract value it implements; an equal-looking action does not match.
- Type error at `command(http, action)`, or `Action "x" is not in this HTTP binding` thrown: the action was not passed to this binding's `ActionHttp.make`. Select with the exact contract value the binding received.
- Type error `Type 'HttpClient' is not assignable to type 'never'` in the pipe that runs a command over HTTP, such as through `NodeRuntime.runMain`: provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`). `HttpClientError` whose `reason._tag` is `InvalidUrlError`: the command's client prepends no URL, and routes are relative outside `Testing.layer`. Connection refused: the prepended URL is wrong. 401 `Unauthenticated`: add credentials to the command's client; the command adds no headers of its own.
- Another command's request goes to the API's URL, or carries its token: the client is configured around the whole program. Configure it on the remote command or aggregate instead.
- `Duplicate command: <name>, claimed by action ... and action ...` thrown by `make`: two actions have the same kebab-case name. Give one a `name` in `commands`, or aggregate them under separate `make` commands.
- `Unknown commands: <keys>` thrown by `make`: a `commands` key names no action of it. Use the action's own name, not its kebab-case command name.
- `No overload matches this call` at `make([...apps, status], { commands: { status: ... } })` in a helper generic over implementations, `<const Apps extends ReadonlyArray<Action.AnyImplementation>>`: through that constraint, `commands` is typed for any action too, and no entry for the helper's own action compiles, `render`, `positional` or `name`. Give that action a command of its own and put both in a tree: `Command.make("x").pipe(Command.withSubcommands([ActionCli.make(apps, { name: "apps" }), ActionCli.command(status, Status, { render })]))`. `Command.withSubcommands` on `make`'s aggregate would replace its subcommands.
- `unknown` among a command's services and failures, and a type error `Type 'unknown' is not assignable to type 'never'` in the pipe that runs it: `make` or `command` was given a binding or implementations chosen by a condition, `make(remote ? Http : users, options)`. Build a command from each and choose between them: `remote ? ActionCli.make(Http, options) : ActionCli.make(users, options)`.
- `Action "x" is implemented twice here` thrown by `command` or `make`: more than one implementation passed implements the selected action. Pass one. Other actions' names are not checked.
- Handler cannot find a service: provide its Layer on the command, `Command.provide(layer)`. The library supplies no service.
- `--help` or a mistyped flag connects to a database, or fails reading config: services are provided around the run, which builds them before parsing. Provide them on the command.
- A command requires a request-identity tag no handler yields: the implementation's `before` hook yields it. Provide a trusted identity on the command, `Command.provideSync(CurrentActor, actor)`; do not remove the authorization hook just to satisfy the service requirement.
- Type error at `Effect.catchTag("UserNotFound", ...)` after `Command.run`: the command fails with `UserError`, whose cause is the action's failure. Catch `"UserError"` and match `error.cause instanceof UserNotFound`. `Command.run` has printed it by then: a recovery that prints nothing, or text of its own, provides a `formatError` through `CliOutput.layer`, or runs with `renderErrors: false`.
- A report with a stack on stdout, `ERROR (#1): ...`, instead of JSON on stderr: a defect, or a failure of a layer the host provides, which `runMain` reports. Fix the defect; to keep such reports and those layers' logs off stdout, report them on stderr as the rules above show.
- The same report for a declared error, such as `UserNotFound`, from a command built with `Command.make`: the command calls `Action.client` or `ActionHttp.client` itself, and its failure is the action's own. Map it to `CliError.UserError`, or derive the command with `command` where its options express the syntax.
