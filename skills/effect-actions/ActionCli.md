# ActionCli

Native Effect CLI commands for actions, with flags derived from each action's input. From
implementations, a command runs the handler in process, with every service the host's; any
implemented action runs locally, whether or not HTTP or MCP serves it. From an HTTP binding,
a command calls the action over HTTP through its `ActionHttp.client` method instead, and runs
nothing locally.

## API

Import `@gjermundgaraba/effect-actions/ActionCli`.

| API                               | Purpose                                                             |
| --------------------------------- | ------------------------------------------------------------------- |
| `command(apps, action, options?)` | One action, selected by its contract, as a native Effect `Command`. |
| `command(http, action, options?)` | One action of an HTTP binding, called over HTTP.                    |
| `make(apps, options)`             | Every implemented action as a subcommand of one aggregate command.  |
| `make(http, options)`             | Every action of the binding as a subcommand, called over HTTP.      |

| Option                  | Meaning                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `command`: `name`       | Override the command name (default: the action name in kebab case).                                          |
| `command`: `render`     | Decoded success to human-readable string; adds `--json`.                                                     |
| `command`: `positional` | Input fields taken as positional arguments instead of flags, in this order.                                  |
| `make`: `name`          | The aggregate's name, required.                                                                              |
| `make`: `commands`      | Each subcommand's `command` options, keyed by action name: `{ readFile: { positional: ["path"], render } }`. |

Exported types: `Options<Actions>` of `make` and `CommandOptions<typeof Action>` of `command`, the same locally and over HTTP. A command over HTTP calls through the host's `HttpClient`, which sets where it sends and any credentials.

Flags come from the action's input. A struct or class input gets one flag per top-level
field, named in kebab case (`tenantId` is `--tenant-id`, `getHTTPUser` is `get-http-user`), parsing the field's encoded JSON
value:

| Encoded field                            | Flag                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| string or template literal               | `--name <string>`; the action's schema checks a template  |
| boolean                                  | `--on`, a switch; omitted is `false` for a required field |
| union of string literals, or string enum | `--kind <choice>`, one of the values                      |
| anything else, numbers included          | `--tags <value>`: JSON the field accepts, or the text     |

An input that is not a struct of named fields (a union, a record, a scalar) gets one
`--input <value>` flag carrying the whole encoded input. An action without input gets no flags.
A value flag parses its text as JSON when the field's encoding accepts the value
(`--count 2`, `--tags '["x"]'`), or else keeps the text (`--limit auto`, `--scale Infinity`
for `Schema.Number`, `--mode true` for `"auto" | string`); the action's schema decodes either.
Choices may be nested unions: `Schema.Union([Schema.Literals(["a", "b"]), Schema.Literal("c")])`
is one choice of three.
A field's description is its flag's help text, whatever its encoding. An optional field's
flag is optional and takes its value without the `null` that `Schema.optional` encodes
(`--name x` for `Schema.optional(Schema.String)`); a required `Schema.NullOr` field takes a value (`--name x`, `--name null`).

A field listed in `positional` is an argument instead of a flag, parsed as its flag would
be, a boolean taking `true` or `false`: `command(apps, Inspect, { positional: ["path"] })`
reads `inspect README.md --lines 10`. Arguments are read in the listed order, not the
input's. An optional field's argument is optional.

A local command retains handler, builder and hook requirements/failures, plus
`SchemaError`, and the invocation owns its scope. A command over HTTP fails with exactly
what the action's `ActionHttp.client` method fails with, and requires an `HttpClient` supplied
by the host. Success output is encoded; failures remain failures of the command Effect.

## Canonical

```ts
import { Console, Effect, Logger } from "effect";
import { Command } from "effect/unstable/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { actors, CurrentActor } from "./authorization.js";
import { Double } from "./contracts.js";
import { double } from "./handlers.js";

// `double --value 21`: one flag per input field. The implementation's hook runs here as
// on the servers; a local caller is not trusted more.
const command = ActionCli.command(double, Double);

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  // No remote caller to authenticate: the host supplies the identity the hook reads.
  Effect.provideService(CurrentActor, actors.alice),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

### Over HTTP

```ts
import { Command } from "effect/unstable/cli";
import { Console, Effect, Logger } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { Http } from "./binding.js";
import { Status } from "./contracts.js";

// From a binding rather than an implementation, the command calls the server instead.
const command = ActionCli.command(Http, Status);

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  // The host's client is the connection: where it sends, and any credentials.
  Effect.updateService(
    HttpClient.HttpClient,
    HttpClient.mapRequest(HttpClientRequest.prependUrl("http://127.0.0.1:3000")),
  ),
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

Credentials go on the same client: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`, with a token read at run time, as from `Config`.

## Rules

- `command(apps, action)` selects the implementation of `action` among `apps` (one implementation or a list) by contract identity, not by name: two contracts that share a name select their own implementations. The action must be one of the implementations' actions: the types refuse an action of another shape, and the runtime check refuses an equal-looking one.
- `make(apps, { name })` puts every implemented action under one command named `name`, one subcommand per action, named after it in kebab case (`getUser` is `get-user`). `commands` gives one subcommand the options `command` takes, by its action's name, typed by that action; a key no action names is refused. That includes actions no HTTP binding or MCP endpoint serves. Subcommand names must be distinct after kebab-casing; two actions whose names collide are refused.
- Flags are values in their encoded form: `double --value 21` for a `FiniteFromString` field, which is string-encoded; a value flag takes the encoded JSON, or text. The action's schema then decodes the assembled input before dispatch.
- A field that is required once encoded has a required flag. Omitted, the parser refuses the command with `Required flag missing` and shows its help, and the implementation is not built. A required boolean is the exception: omitted, its switch is `false`.
- An optional field's flag is optional. Omitting it leaves the field out, including a field with a decoding default. The action's schema then decodes what the flags parsed, so transforms and cross-field rules still apply.
- `positional` names fields of a struct or class input, and the types offer none for any other input, a union included. Each is listed once, and every required field before any optional one, since a parser reads arguments in order. Remote commands take it too.
- The flags follow the schema: renaming a field renames its flag. For a fixed syntax, build the command with native `Command.make`, `Flag` and `Argument`, and call the handler or client in it.
- Output is validated and encoded before printing. Default output is JSON. An action whose `success` is `Schema.Void` prints nothing. `render(decoded)` gives human output and adds a `--json` flag to that command, which selects JSON again. Rendering cannot bypass validation.
- `--json` is a regular flag of the rendered command only. A command without `render` has no such flag: its output is JSON already. Nothing is declared tree-wide, so a host CLI may declare its own `--json`, global or not.
- Each invocation builds the selected implementation's builder in a scope of its own and releases it after the call. Only that implementation's builder runs: other implementations passed alongside it, on `command` or `make`, are not built. Domain services and authority come from the host's provided layers. There is no HTTP fallback.
- A local command is a local surface: the implementation's `before` runs before the selected handler, on `command` and on every subcommand of `make`, and the host provides the identity the hook reads, as `Effect.provideService(CurrentActor, actor)`. A CLI is not a trusted bypass; a trusted admin CLI implements the same handlers without `before`.
- The CLI does not serialize a refusal: it is a typed failure of the command effect. Every local command's error channel includes `Action.Refusal`, whatever its implementation's hook. Invalid input fails decoding before the hook, so it skips the hook and handler.
- From a binding, `command(http, action)` takes one of the binding's actions, matched by object identity at runtime, and calls its route, `<prefix>/<action>`, through the action's `ActionHttp.client` method. `make(http, { name })` projects every action of the binding, the same tree `make` builds locally, with the same options.
- A command over HTTP runs no hook: the server owns authentication and authorization. The host provides `HttpClient` and configures it: where it sends, `HttpClient.mapRequest(HttpClientRequest.prependUrl(url))`, and credentials, `HttpClientRequest.bearerToken(token)`, read at run time. Nothing is inferred from action arguments.
- Over HTTP, input is decoded by the action schema before dispatch, then passed to the native client at its normal codec boundary. Errors are the client's: the action's declared errors, the built-in errors ([guarantees.md](guarantees.md#wire-behavior)), `SchemaError`, and `HttpClientError`.
- For a custom tree, compose individual `command` results with native `Command` combinators (`Command.make(name).pipe(Command.withSubcommands([...]))`).

## Failure modes

- Native `CliError.ShowHelp` containing `MissingOption` (`Required flag missing: <flag>`): a required field's flag was not given. Pass it.
- `SchemaError` for a value that looks right: the flag takes the encoded value, such as `"21"` for `FiniteFromString`. For `--input` or a value flag, the JSON or text may not be the field's encoding; malformed JSON is taken as text. Quote a string that reads as JSON: `--id '"123"'` for a `String | Number` field.
- Native `CliError.ShowHelp` containing `InvalidValue`: the parser rejected a flag's text before the command ran: a choice outside its values.
- Native `CliError.ShowHelp` containing `MissingArgument`: a required positional argument was not given. A positional field has no flag, so `--<field>` does not supply it.
- Thrown by `command` when the command is built: `Duplicate positional argument: <field>` (listed twice), or `Required positional argument after an optional one: <field>` (reorder the list, or make the earlier field required).
- Also thrown by `command`, and refused by the types first: `Not an input field: <field>`, or `Positional arguments need named input fields` for an input that is not a struct.
- `Duplicate flag: --<name>, claimed by ...` thrown by `command` or `make`: two flags of one command share a name. Examples are two input fields with the same kebab-case name (`userId`, `user_id`), or a `json` field beside `render`'s `--json`. Rename the field, or drop `render`.
- A field named like a global flag (`help`, `version`, `log-level`) is not a clash: its flag shadows the global one on that command.
- Type error at `command`, or `Action "x" has no implementation here` thrown: the action is not the contract of any implementation in `apps`. Pass the implementation too, and select with the exact contract value it implements; an equal-looking action does not match.
- Type error at `command(http, action)`, or `Action "x" is not in this HTTP binding` thrown: the action was not passed to this binding's `ActionHttp.make`. Select with the exact contract value the binding received.
- `HttpClient` missing at runtime for a command over HTTP: provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`). `HttpClientError` whose `reason._tag` is `InvalidUrlError`: the host's client prepends no URL, and routes are relative outside `Testing.layer`. Connection refused: the prepended URL is wrong. 401 `Unauthenticated`: add credentials to the host's client; the command adds no headers of its own.
- `Duplicate command: <name>, claimed by action ... and action ...` thrown by `make`: two actions have the same kebab-case name. Give one a `name` in `commands`, or aggregate them under separate `make` commands.
- `Unknown commands: <keys>` thrown by `make`: a `commands` key names no action of it. Use the action's own name, not its kebab-case command name.
- `Action "x" is implemented twice here` thrown by `command`: more than one implementation passed implements the selected action. Pass one. Other actions' names are not checked.
- Handler cannot find a service: provide its Layer to the runtime (`Effect.provide`) before `runMain`. The command does not supply services.
- A command requires a request-identity tag no handler yields: the implementation's `before` hook yields it. Provide a trusted identity around the invocation; do not remove the authorization hook just to satisfy the service requirement.
