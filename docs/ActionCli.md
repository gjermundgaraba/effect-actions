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
| `onStderr`                                   | Applied last before `runMain`: stdout carries only results.         |

| Option                  | Meaning                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `command`: `name`       | Override the command name (default: the action name in kebab case).                                          |
| `command`: `render`     | Decoded success to human-readable string; adds `--json`.                                                     |
| `command`: `positional` | Input fields taken as positional arguments instead of flags, in this order.                                  |
| `command`: `aliases`    | A short name per field's flag: `{ limit: "n" }` takes `-n 5` beside `--limit 5`.                             |
| `make`: `name`          | The aggregate's name, required.                                                                              |
| `make`: `actions`       | The actions that are subcommands, among the implementations' or the binding's; defaults to every one.        |
| `make`: `commands`      | Each subcommand's `command` options, keyed by action name: `{ readFile: { positional: ["path"], render } }`. |
| Over HTTP: `client`     | The `ActionHttp.client` options, `baseUrl` and `transformClient`, for this command's or aggregate's client.  |

Exported types: `Options<A>` of `make`, `A` the union of its actions, such as `typeof GetUser | typeof RenameUser`; `CommandOptions<typeof Action>` of `command`, the same locally and over HTTP, where both also take `client`, an `ActionHttp.ClientOptions`; and `Failure<E>`, a type only: what a command fails with when its action fails, Effect CLI's `CliError.UserError` whose `cause`, and `reason`, is the failure `E`. A command over HTTP calls through the host's `HttpClient`, configured by its `client` options: where it sends and any credentials.

Flags come from the action's input. A struct or class input gets one flag per top-level
field, named in kebab case (`tenantId` is `--tenant-id`, `getHTTPUser` is `get-http-user`, `_id` is `--id`), parsing the field's encoded JSON
value:

| Encoded field                            | Flag                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------- |
| string or template literal               | `--name <string>`; the action's schema checks a template              |
| boolean                                  | `--on`, a switch; omitted is `false` for a required field             |
| union of string literals, or string enum | `--kind <choice>`, one of the values                                  |
| array of strings or numbers, or choices  | `--tag <value>`, repeated: one element per occurrence; `[]` adds none |
| anything else, numbers included          | `--owner <value>`: JSON the field accepts, or the text                |

A suspended input or field, as a recursive schema is written, counts as the schema it stands
for, its description included.

An input that is not a struct of named fields (a union, a record, a scalar) gets one
`--input <value>` flag carrying the whole encoded input. Left off, the input is `{}`, which the
action's schema decodes when the command runs. A schema accepting `{}`, including a union
with such a member, succeeds; otherwise the command fails with `InvalidInput`. An action without input gets no flags.
A repeated flag reads each occurrence as one element, as the flag of that element would:
`--provider exa --provider hn` for `Schema.Array(Schema.Literals(["exa", "hn"]))`. Given none, a
required field is `[]` and an optional one is left out; a `Schema.NonEmptyArray` field's flag is
required once. An occurrence of `[]` adds no element, and is one of a choice's values, so
`--tags '[]'` alone sends `[]`, clearing an optional field the flag would otherwise leave out; an
element whose text is `[]` cannot be sent. Any other array, such as one of objects, takes JSON,
`--points '[{"x":1}]'`.
A value flag parses its text as JSON when the field's encoding accepts that kind of value
(`--count 2`, `--owner '{"id":"x"}'`), or else keeps the text (`--limit auto`, `--scale Infinity`
for `Schema.Number`, `--mode true` for `"auto" | string`); the action's schema decodes either.
Only the kind decides: JSON breaking a rule, such as `--width 0` where it must be positive, stays
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
input's. An optional field's argument is optional. An array whose flag repeats is a repeated
argument, one element per value, as its flag takes them, `[]` included: `remove a.txt b.txt` for
`{ positional: ["paths"] }`. It takes every value left, so it is listed last. A JSON or text
argument is shown in help as `value`, as its flag is.
`aliases` gives a field's flag a short name too, as native `Param.withAlias` does:
`{ aliases: { limit: "n" } }` takes `-n 5` beside `--limit 5`.

A local command requires what its handler, builder and authorizer require, the layers of its
action's checks, and a protected action's identity, and the invocation owns its scope. Its
`Failure`'s cause is what the action, its authorizer, a check or the builder fails with, or a
built-in error. A command over HTTP requires an `HttpClient` supplied by the host, and its
cause is exactly what the action's `ActionHttp.client` method fails with. A command prints
only the encoded success on stdout; `Command.run` prints a failure on stderr.

## Canonical

```ts example=cli.ts
import { Effect } from "effect";
import { Command } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { actors, CurrentActor } from "./authorization.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

// `users get-user --id 1`: a subcommand per action, a flag per input field. The
// implementation's `authorize` runs here as on the servers; a local caller is not trusted more.
const cli = ActionCli.make(userActions, { name: "users" }).pipe(
  // Services go on the command: built when an action runs, never for `--help` or a
  // mistyped flag.
  Command.provide(Users.layerMemory),
  // No remote caller to authenticate: the host supplies the identity the contracts declare.
  Command.provideSync(CurrentActor, actors.alice),
);

// Effect's own runner: the result goes to stdout, and a failure to stderr as the JSON HTTP
// sends, such as `{"_tag":"UserNotFound","id":"9"}`, exiting 1. `onStderr`, applied last,
// sends every other report and log there too, so scripts read stdout alone.
Command.run(cli, { version: "0.1.0" }).pipe(
  Effect.provide(NodeServices.layer),
  ActionCli.onStderr,
  NodeRuntime.runMain,
);
```

### Over HTTP

```ts example=cli-remote.ts
import { Command } from "effect/cli";
import { Effect } from "effect";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { Http } from "./binding.js";
import { Status } from "./contracts.js";

// From a binding rather than an implementation, the command calls the server instead. Its
// client options are the connection, as `ActionHttp.client` takes them: where it sends, and
// any credentials, which reach no other request the program makes.
const command = ActionCli.command(Http, Status, { client: { baseUrl: "http://127.0.0.1:3000" } });

Command.run(command, { version: "0.1.0" }).pipe(
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
```

A static token goes in the same options, `transformClient:
HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`. A URL or credentials read when a
command runs, as from `Config`, configure the client the command is provided instead. An
aggregate nests in the host's own tree like any native command, and what it is provided
reaches its own commands alone:

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

### Trusted callers

An operator's command beside remote callers, from one implementation and one `authorize`. The
identity is typed in two parts: what a verifier returns, and what only the host supplies, so no
verified token, and no claim mapped onto a role, names the trusted operator. The host provides
it on its own command; every check still runs for it.

```ts example=cli-admin.ts
import { Context, Effect, Layer, Redacted } from "effect";
import { Command } from "effect/cli";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";

/** What a verified token can name. */
export interface RemoteOperator {
  readonly id: string;
  readonly role: "viewer" | "editor";
}

/** What only a host supplies: no verifier returns one. */
export interface TrustedOperator {
  readonly id: string;
  readonly role: "trusted";
}

export class Operator extends Context.Service<Operator, RemoteOperator | TrustedOperator>()(
  "example/Operator",
) {}

export const Purge = Action.make("purge", {
  description: "Purge the cache.",
  access: "write",
  auth: Operator,
});

// One rule for every caller: a trusted operator passes, a remote one needs the editor role.
export const cache = Action.implement(Purge, () => Effect.log("Purged."), {
  authorize: (action) =>
    Effect.gen(function* () {
      const operator = yield* Operator;

      if (operator.role === "trusted") return;

      if (action.access === "write" && operator.role !== "editor") {
        return yield* new Action.Forbidden({ message: "Requires the editor role." });
      }
    }),
});

const OperatorLogin = Authentication.make("example.OperatorLogin", Operator);

export const Http = ActionHttp.make([Purge], { authentication: OperatorLogin });

// DEMO ONLY: a token is a role. Typed as the remote subset, so no token, and no claim mapped
// onto `role`, can name the trusted operator.
const verify = (
  token: Redacted.Redacted<string>,
): Effect.Effect<RemoteOperator, Action.Unauthenticated> => {
  const role = Redacted.value(token);

  return role === "viewer" || role === "editor"
    ? Effect.succeed({ id: role, role })
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
};

export const routes = ActionHttp.layer(Http, cache).pipe(
  Layer.provide(Authentication.layer(OperatorLogin, verify)),
);

const operator: TrustedOperator = { id: "ops", role: "trusted" };

// The host's own command, `ops purge`: the same implementation and rule, and its checks too,
// run as the trusted operator the host supplies. Nothing remote can reach it.
export const cli = ActionCli.make(cache, { name: "ops" }).pipe(
  Command.provideSync(Operator, operator),
);
```

## Rules

- `command(implementations, action)` selects the implementation of `action` among `implementations` (one implementation or a list) by contract identity, not by name: two contracts that share a name select their own implementations. The action must be one of the implementations' actions: the types refuse an action of another shape, and the runtime check refuses an equal-looking one.
- `make(implementations, { name })` puts every implemented action under one command named `name`, or those `actions` lists, each keeping its implementation's authorizer and its checks, one subcommand per action, named after it in kebab case (`getUser` is `get-user`). `commands` gives one subcommand the options `command` takes, by its action's name, typed by that action. It takes any action of the binding or the implementations, so one record serves aggregates of several selections: a command of an action `actions` leaves out is unused. A key no action of them names is refused. That includes actions no HTTP binding or MCP endpoint serves. Subcommand names must be distinct after kebab-casing; two actions whose names collide are refused.
- Flags are values in their encoded form: `double --value 21` for a `FiniteFromString` field, which is string-encoded; a value flag takes the encoded JSON, or text. The action's schema then decodes the assembled input before dispatch.
- A field that is required once encoded has a required flag. Omitted, the parser refuses the command with `Missing required flag: --<flag>` and shows its help, and the implementation is not built. A required boolean is the exception: omitted, its switch is `false`.
- An optional field's flag is optional. Omitting it leaves the field out, including a field with a decoding default. The action's schema then decodes what the flags parsed, so transforms and cross-field rules still apply.
- `positional` names fields of a struct or class input, and the types offer none for any other input, a union included. Each is listed once, and every required field before any optional one, since a parser reads arguments in order; an array taken as a repeated argument comes last, as it reads every value left. Remote commands take it too, and `aliases`, which names only flagged fields of such an input, each alias once.
- The flags follow the schema: renaming a field renames its flag. `name`, `positional`, `aliases` and `render` give a command its name, its arguments, its short flags and its output, and keep every rule of this page: prefer a derived command wherever they express the syntax. For a syntax they cannot, such as a flag named apart from its field, or a command calling several actions, build the command with native `Command.make`, `Flag` and `Argument`, and call the actions in it through `Action.client`, acquired in its handler, inside `Effect.scoped`, so each invocation builds and releases it ([Action.md](Action.md#clients)), or over HTTP through the binding's `ActionHttp.client`. Calling a handler directly bypasses decoding, the implementation's authorizer and the action's checks.
- Such a command is the host's own: through `Action.client` the authorizer and every check run, but the output, failure and logging rules of this page do not apply. It prints what it prints, its logs go where the host's logger writes, and a failure it leaves as it is is the action's own, not a `Failure`, which `runMain` reports on stdout with a stack and without its fields. Map it to Effect CLI's `CliError.UserError`, `new CliError.UserError({ cause, userMessage })`, for `Command.run` to print `userMessage` on stderr.
- Output is validated and encoded before printing. Default output is JSON. `render(decoded)` gives human output and adds a `--json` flag to that command, which selects JSON again. An action whose `success` is `Schema.Void` prints nothing by default or with `--json`; a custom `render` can still print human output. Rendering cannot bypass validation: a success its schema does not encode is a defect, as on HTTP, and nothing prints it.
- `--json` is a regular flag of the rendered command only. A command without `render` has no such flag: its output is JSON already. Nothing is declared tree-wide, so a host CLI may declare its own `--json`, global or not.
- Each invocation builds the selected implementation's builder, and its authorizer when an Effect builds it, in a scope of its own and releases them after the call. Only that implementation's builder runs: other implementations passed alongside it, on `command` or `make`, are not built. Domain services, the layers of the actions' checks and authority come from layers the host provides on the command, `Command.provide(layer)`, `Command.provide(LimitedLive)`: built when the command runs, before its input is decoded, so input the action's schema refuses is refused after they are built; `--help` and the parser's errors, such as a missing or unknown flag, never build them. `make`'s aggregate run alone builds them before showing its help, since its own handler shows it, and fails instead if one fails. There is no HTTP fallback.
- A local command is a local surface: the implementation's `authorize` runs before a protected action's handler, then its checks, on `command` and on every subcommand of `make`, and the host provides the identity a protected action declares on the command, `Command.provideSync(CurrentActor, actor)`, or `Command.provideEffect(CurrentActor, load)` to read it when an action runs. Its type requires it whether or not the handler or the authorizer reads it.
- A CLI is not a trusted bypass: it runs the same authorizer and checks as every surface, and takes no authorization of its own. A trusted operator is an identity the host supplies on its own command, typed apart from what a verifier returns, which the shared `authorize` admits ([Trusted callers](#trusted-callers)). A verifier typed to return the remote part cannot name it. The library cannot tell which identities are trusted: keep the trusted part out of every verifier's return type.
- A command writes only its result to stdout: the builder, authorizer, checks and handler, or the client, and the codecs of its input, success and failures, write their Effect logs and Effect `Console` output to stderr, whatever logger prints them. The global `console.log` and other direct writes bypass Effect and still reach stdout: keep them off stdout.
- When its action fails, a command fails with Effect CLI's `UserError`, typed `Failure<E>`, whose `cause` is that failure: a declared error, a binding's, a built-in one, or a builder's. Its message is the JSON HTTP sends for it ([guarantees.md](guarantees.md#wire-behavior)), such as `{"_tag":"UserNotFound","id":"9"}`. `Command.run` prints it on stderr through Effect's `CliOutput` formatter and marks it reported, so `NodeRuntime.runMain` prints it no more, and the process exits 1, or with the cause's `Runtime.errorExitCode`. A failure no schema encodes, a builder's or the transport's, prints as its tag, or an error's name, and its message, then each cause's, up to one already printed, and never its other fields, a plain object's `name` among them.
- Every local command may fail with `Action.BuiltIn`, whatever its implementation's authorizer. Input that does not decode is `InvalidInput`, as over HTTP: it skips the authorizer, the checks and the handler.
- After `Command.run` the failure may be any `UserError`, the parser's too, so a host matches the action's by its tag with Effect's own `catchReason`, after `Command.run` has printed it: `Effect.catchReason("UserError", "UserNotFound", (missing) => ...)`, or `Effect.catchReasons("UserError", { UserNotFound, Forbidden })` for several, decides what follows, such as the exit code, not what was printed. A `Failure`'s `reason` is its `cause`; a `UserError` the parser fails with has none, so it passes through. The types take a tag only where every failure of the command is tagged, as Effect's errors are: a builder failing with a plain `Error` leaves `catchReason` no tag to match, so fail with a tagged error. `Failure` is a type only, since `instanceof` would leave its cause `any`. For text of its own, the host provides Effect's formatter, `CliOutput.layer(Object.assign({}, CliOutput.defaultFormatter(), { formatError }))`; `Command.run(cli, { version, renderErrors: false })` has it print every failure itself, the parser's too.
- `runMain` reports what is not a command's failure, outside the program, on stdout: a defect, such as a handler's bug or a success that does not encode, and a failure of a layer the host provides, on the command or around the run. Those layers log outside the command too, on stdout. A CLI whose stdout feeds scripts applies `onStderr` last, before `runMain`, as the example does: the default logger of every layer within writes to stderr, and what `runMain` would report is reported on stderr instead, once, a command's failure `Command.run` printed never again. The process exits as `runMain` makes it: 0, the failure's `Runtime.errorExitCode` or 1, or 130 for an interruption. `onStderr` does not move those layers' `Console` output or a logger writing through `Console.log`, such as `Logger.consoleJson`: log JSON with `Logger.withConsoleError(Logger.formatJson)`. It is the program's last step, so a custom `teardown` or an outer handler of defects sees a defect standing for the report, an `Error` carrying the exit code, whose `cause` is the original `Cause`. An MCP subprocess applies it after `runStdio` the same way ([ActionMcp.md](ActionMcp.md#rules)).
- From a binding, `command(http, action)` takes one of the binding's actions, matched by object identity at runtime, and calls its route, `<prefix>/<action>`, through the action's `ActionHttp.client` method. `make(http, { name })` projects every action of the binding, the same tree `make` builds locally, with the same options.
- A command over HTTP runs no authorization or check of its own: the server owns authentication, authorization and checks. The host provides `HttpClient`, and the remote command or aggregate configures its own client with `client`, the options `ActionHttp.client` takes: where it sends, `baseUrl`, and credentials, `transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`. One aggregate has one connection: its `commands` take no `client`, and the types refuse `client` on a command from implementations, which `command` and `make` also throw (`Client options are for a command over HTTP: pass a binding`). Settings read when a command runs, as from `Config`, configure the client provided on the remote command or aggregate instead, `Command.provideEffect(HttpClient.HttpClient, ...)`, prepending the URL with `HttpClient.mapRequest(HttpClientRequest.prependUrl(url))`. Configured around the whole program, the client would rewrite every request the program makes, an absolute URL too, and send each the credentials. Nothing is inferred from action arguments.
- Over HTTP, input is decoded by the action schema before dispatch, then passed to the native client at its normal codec boundary. A failure's cause is the client's: the action's and binding's declared errors, the built-in errors ([guarantees.md](guarantees.md#wire-behavior)), `SchemaError` for an answer that does not decode, and `HttpClientError`. Input that does not decode is `InvalidInput`, and sends nothing.
- For a custom tree, compose individual `command` results with native `Command` combinators (`Command.make(name).pipe(Command.withSubcommands([...]))`). `make`'s aggregate nests in a host's tree the same way, and what it is provided reaches its own subcommands alone.

## Failure modes

- `Missing required flag: --<flag>` on stderr, after the command's help on stdout, from a native `CliError.ShowHelp` containing `MissingOption`: a required field's flag was not given. Pass it.
- `InvalidInput` naming an unexpected key: `--input` or a flag's JSON holds a field the schema does not declare, such as a misspelling. Undeclared fields are refused, never dropped.
- `InvalidInput` from a command whose input is not a struct, run without `--input`: the schema rejects the default `{}`. Pass `--input` with a value the schema accepts.
- `InvalidInput` for a value that looks right: the flag takes the encoded value, such as `"21"` for `FiniteFromString`. For `--input` or a value flag, the JSON or text may not be the field's encoding; malformed JSON is taken as text. Quote a string that reads as JSON: `--id '"123"'` for a `String | Number` field.
- `Invalid value for flag --<flag>: "<value>". Expected: ...`, or `Missing value for flag --<flag>`, from a native `CliError.ShowHelp` containing `InvalidValue`: the parser rejected a flag's text before the command ran: a choice outside its values, or none.
- `Missing required argument: <field>`, from a native `CliError.ShowHelp` containing `MissingArgument`: a required positional argument was not given. A positional field has no flag, so `--<field>` does not supply it.
- Thrown by `command` when the command is built: `Duplicate positional argument: <field>` (listed twice), `Required positional argument after an optional one: <field>` (reorder the list, or make the earlier field required), or `Repeated positional argument before another one: <field>` (an array taken as an argument reads every value left: list it last).
- Thrown by `command` when the command is built: `Not a flag's input field: <field>` (an alias names a field that is positional, or no field), or `Aliases need named input fields: <fields>` (the input is not a struct).
- Also thrown by `command`, and refused by the types first: `Not an input field: <field>`, or `Positional arguments need named input fields` for an input that is not a struct.
- `Duplicate flag: --<name>, claimed by ...` thrown by `command` or `make`: two flags of one command share a name. Examples are two input fields with the same kebab-case name (`userId`, `user_id`), a `json` field beside `render`'s `--json`, or an alias another flag's name or alias takes (`aliases: { limit: "all" }` beside an `all` field). Rename the field or the alias, or drop `render`.
- A field named like a global flag (`help`, `version`, `log-level`) is not a clash: its flag shadows the global one on that command.
- Type error at `command`, or `Action "x" has no implementation here` thrown: the action is not the contract of any implementation in `implementations`. Pass the implementation too, and select with the exact contract value it implements; an equal-looking action does not match.
- Type error at `command(http, action)`, or `Action "x" is not in this HTTP binding` thrown: the action was not passed to this binding's `ActionHttp.make`. Select with the exact contract value the binding received.
- Type error `Type 'HttpClient' is not assignable to type 'never'` in the pipe that runs a command over HTTP, such as through `NodeRuntime.runMain`: provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`). `HttpClientError` whose `reason._tag` is `InvalidUrlError`: the command's client has no `baseUrl` and prepends no URL, and routes are relative outside `Testing.layer`. Connection refused: the URL is wrong. 401 `Unauthenticated`: add credentials to the command's client, in `client`'s `transformClient` or on the client it is provided; the command adds no headers of its own.
- Another command's request goes to the API's URL, or carries its token: the client is configured around the whole program. Configure it with the remote command's or aggregate's `client`, or provide it on that command instead.
- `Duplicate command: <name>, claimed by action ... and action ...` thrown by `make`: two actions have the same kebab-case name. Give one a `name` in `commands`, or aggregate them under separate `make` commands.
- `Unknown commands: <keys>` thrown by `make`: a `commands` key names no action of the binding or the implementations. Use the action's own name, not its kebab-case command name.
- `No overload matches this call` at `make([...apps, status], { commands: { status: ... } })` in a helper generic over implementations, `<const Apps extends ReadonlyArray<Action.AnyImplementation>>`: through that constraint, `commands` is typed for any action too, and no entry for the helper's own action compiles, `render`, `positional` or `name`. Give that action a command of its own and put both in a tree: `Command.make("x").pipe(Command.withSubcommands([ActionCli.make(apps, { name: "apps" }), ActionCli.command(status, Status, { render })]))`. `Command.withSubcommands` on `make`'s aggregate would replace its subcommands.
- `unknown` among a command's services and failures, and a type error `Type 'unknown' is not assignable to type 'never'` in the pipe that runs it: `make` or `command` was given a binding or implementations chosen by a condition, `make(remote ? Http : users, options)`. Build a command from each and choose between them: `remote ? ActionCli.make(Http, options) : ActionCli.make(users, options)`.
- `Action "x" is implemented twice here` thrown by `command` or `make`: more than one implementation passed implements the selected action. Pass one. Other actions' names are not checked.
- Handler cannot find a service: provide its Layer on the command, `Command.provide(layer)`. The library supplies no service.
- `--help` or a mistyped flag connects to a database, or fails reading config: services are provided around the run, which builds them before parsing. Provide them on the command.
- A command requires a request-identity tag no handler yields: the action is protected, and its caller is owed whatever the handler reads. Provide the identity on the command, `Command.provideSync(CurrentActor, actor)`; do not make the contract public just to satisfy the requirement.
- A command requires a check, such as `Limited`: an action it serves lists it. Provide its layer on the command, `Command.provide(LimitedLive)`.
- Type error at `Effect.catchTag("UserNotFound", ...)` after `Command.run`: the command fails with `UserError`, whose reason is the action's failure. Use `Effect.catchReason("UserError", "UserNotFound", ...)`. `Command.run` has printed it by then: a recovery that prints nothing, or text of its own, provides a `formatError` through `CliOutput.layer`, or runs with `renderErrors: false`.
- A report with a stack on stdout, `ERROR (#1): ...`, instead of JSON on stderr: a defect, or a failure of a layer the host provides, which `runMain` reports. Fix the defect; to keep such reports and those layers' logs off stdout, apply `onStderr` last, before `runMain`.
- Type error at `Effect.catchReason("UserError", "<Tag>", ...)`, its tag typed `never`: a failure of the command has no `_tag`, such as a builder's plain `Error`. Fail with a tagged error, such as a `Schema.TaggedError` or `Data.TaggedError`.
- `Listed in actions, but no implementation holds it: <names>`, or `but the binding does not hold it`, thrown by `make`: those actions are not among the implementations' or the binding's, by identity. `(another contract)` marks one whose name they hold, as a second copy of the contracts module makes. List the contract they implement or bind.
- The same report for a declared error, such as `UserNotFound`, from a command built with `Command.make`: the command calls `Action.client` or `ActionHttp.client` itself, and its failure is the action's own. Map it to `CliError.UserError`, or derive the command with `command` where its options express the syntax.
