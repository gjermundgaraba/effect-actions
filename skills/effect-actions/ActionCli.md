# ActionCli

Native Effect CLI commands for actions. From implementations, a command runs the handler
in process, with every service the host's; any implemented action runs locally, whether or
not HTTP or MCP serves it. From an HTTP binding, a command calls the action over HTTP
through its `ActionHttpClient` method instead, and runs nothing locally.

## API

Import `@gjermundgaraba/effect-actions/ActionCli`.

| API                                          | Purpose                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `command(apps, action, options?)`            | One action, selected by its contract, as a native Effect `Command`.        |
| `command(http, action, options?)`            | One action of an HTTP binding, called over HTTP.                           |
| `make(apps, options)`, `make(http, options)` | Every action as a subcommand of one aggregate command, local or over HTTP. |
| `Options`, `MakeOptions`                     | Configuration for local single and aggregate commands.                     |
| `RemoteOptions`, `RemoteMakeOptions`         | Configuration for commands called over HTTP.                               |

| Option                       | Meaning                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `name`                       | `command`: override the command name (default: the action name). `make`: the aggregate's name, required. |
| `before`                     | Local only. Hook receiving the selected `Action.Any`; its failures and services join the command's.      |
| `render`                     | Single command only: decoded success to human-readable string; adds `--json`.                            |
| `parameters`                 | Single command only. Native flag/argument config; the parsed values are the encoded input.               |
| `input`                      | Single command only, with `parameters`: maps the parsed values to the encoded input when they differ.    |
| `baseUrl`, `transformClient` | Over HTTP only: the native client's options, as `ActionHttpClient.make` takes them.                      |

Without `parameters`, a command accepts `--input` and `--input-file`. A local command retains
handler, builder and hook requirements/failures, plus codec failures, and the invocation owns
its scope. A command over HTTP fails with exactly what the action's `ActionHttpClient` method
fails with, and requires an `HttpClient` supplied by the host. Success output is encoded;
failures remain failures of the command Effect.

## Canonical

```ts
import { Console, Effect, Logger } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { actors, CurrentActor, guarded } from "./auth.js";
import { Double } from "./contracts.js";
import { double } from "./handlers.js";

// The CLI binds the same guard as the servers; a local caller is not trusted more.
// The parsed `{ value }` is the action's encoded input as it is.
const command = ActionCli.command(double, Double, {
  parameters: { value: Flag.String("value") },
  ...guarded,
});

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  // The hook runs here too, so a local caller supplies an identity for it
  // exactly as HTTP middleware does for a request.
  Effect.provideService(CurrentActor, actors.alice),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

### Over HTTP

```ts
import { Command } from "effect/unstable/cli";
import { Console, Effect, Logger } from "effect";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { Http } from "./binding.js";
import { Status } from "./contracts.js";

// From a binding rather than an implementation, the command calls the server instead.
const command = ActionCli.command(Http, Status, { baseUrl: "http://127.0.0.1:3000" });

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  // The host supplies the native client and its configuration.
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

Authentication: `transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.

## Rules

- `command(apps, action)` selects the implementation of `action` among `apps` (one implementation or a list) by contract identity, not by name: two contracts that share a name select their own implementations. The action must be one of the implementations' actions: the types refuse an action of another shape, and the runtime check refuses an equal-looking one.
- `make(apps, { name })` puts every implemented action under one command named `name`, one subcommand per action, named after it. That includes actions no HTTP binding or MCP endpoint serves. Subcommand names must be distinct; two implementations of actions with the same name are refused.
- Default syntax is `--input '<json>'` or `--input-file <path>` carrying the entire encoded input: nested objects, arrays, scalars. The file is read and JSON-parsed by the native `Flag.FileSchema`. Both are decoded by the native parser; if both are given, the file is used. Omitting both decodes `{}` separately on every invocation; result identity follows the codec's behavior. An action that requires input then fails with a `SchemaError`, exactly as a `parameters` command's mapped input does.
- With `parameters`, the command has explicit native flags and arguments and neither `--input` nor `--input-file`, so its syntax does not change when the schema changes.
- The parsed parameters are the encoded input: `{ value: Flag.String("value") }` parses to `{ value }`. `input` may be left out only when they could be: JSON values, every key the encoded input requires and none it lacks; otherwise it is a compile error, and `input(parsed)` returns the encoded JSON instead. An optional flag parses to an `Option`, which always needs `input`. The action schema decodes it before dispatch; a mismatch is a `SchemaError` at runtime, and the implementation is not built. Action fields are never turned into flags automatically.
- Native `Flag` and `Argument` own names, aliases, ordering, defaults, and optionality. Use `Flag.optional` when omission must stay distinct from a default, and map the `Option` to a present or omitted field with `input`; an `Option` is not encoded input.
- Output is validated and encoded before printing. Default output is JSON. `render(decoded)` gives human output and adds a `--json` flag to that command, which selects JSON again. Rendering cannot bypass validation.
- `--json` is a regular flag of the rendered command only. A command without `render` has no such flag: its output is JSON already. Nothing is declared tree-wide, so a host CLI may declare its own `--json`, global or not. A rendered `parameters` command reserves the flag name; a payload field named `json` is ordinary data.
- Each invocation builds the selected implementation's builder in a scope of its own and releases it after the call. Only that implementation's builder runs: other implementations passed alongside it, on `command` or `make`, are not built. Domain services and authority come from the host's provided layers. There is no HTTP fallback.
- `before` runs before the selected handler, on `command` and on every subcommand of `make`. Its services are the caller's to provide, so a local CLI supplies the identity the hook reads exactly as HTTP middleware does. A CLI is not a trusted bypass.
- The CLI does not serialize a refusal: it is a typed failure of the command effect, inferred from `before`. A guard shared with the other surfaces, `{ errors, before }`, is spread in as it is; the CLI reads only `before`. Success values are still validated and encoded for output. The native parser also decodes `--input` and `--input-file` before the command runs, so invalid input skips the hook and handler.
- From a binding, `command(http, action)` takes one of the binding's actions, matched by object identity at runtime, and calls its route, `<prefix>/<action>`, through the action's `ActionHttpClient` method. `make(http, { name })` projects every action of the binding, the same tree `make` builds locally. Nothing in the options selects another endpoint.
- A command over HTTP binds no `before`: the server owns authorization. The host provides `HttpClient` and its configuration; credentials are the host's, and nothing is inferred from action arguments. Input is decoded by the action schema before dispatch, then passed to the native client at its normal codec boundary. Errors are the client's: the action's declared errors, the binding's `errors`, `SchemaError`, and `HttpClientError`.
- `make` subcommands use the default JSON syntax. For a custom tree, compose individual `command` results with native `Command` combinators (`Command.make(name).pipe(Command.withSubcommands([...]))`).

## Failure modes

- Native `CliError.ShowHelp` containing `InvalidValue` for a supplied `--input` or `--input-file`: the parser rejected its JSON or schema before the command handler ran. Supply encoded input (`"21"` for `FiniteFromString`, not `21`). With neither flag, decoding the default `{}` can fail with `SchemaError`; so can a `parameters` command's mapped input or an invalid success value.
- Command rejects `--input` or `--input-file`: the command was built with `parameters`. Use its flags.
- Type error at `command` naming `input`: the parsed parameters are not the encoded input (an `Option`, a renamed or missing field). Map them with `input`.
- `SchemaError` for a `parameters` command given valid flags: a parsed value has the right key but the wrong encoding, such as a number for a string-encoded field. Values are checked by decoding, not by the types.
- Type error at `command`, or `Action "x" has no implementation here` thrown: the action is not the contract of any implementation in `apps`. Pass the implementation too, and select with the exact contract value it implements; an equal-looking action does not match.
- Type error at `command(http, action)`, or `Action "x" is not in this HTTP binding` thrown: the action was not passed to this binding's `ActionHttp.make`. Select with the exact contract value the binding received.
- `HttpClient` missing at runtime for a command over HTTP: provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`). Connection refused: `baseUrl` is absent or wrong; it has no default. 401: add `transformClient`; the command adds no headers of its own.
- `HttpClientError` with a decode error on a status the server does answer: that status's error is declared neither on the action nor in the binding's `errors`. Declare it on `ActionHttp.make`.
- `Duplicate command: <name>` thrown by `make`: two implementations are of actions with the same name. Aggregate them under separate `make` commands, or compose `command` results with a `name` override.
- Handler cannot find a service: provide its Layer to the runtime (`Effect.provide`) before `runMain`. The command does not supply services.
- A command requires a request-identity tag no handler yields: the `before` hook yields it. Provide a trusted identity around the invocation; do not remove the authorization hook just to satisfy the service requirement.
- `--json` flag conflict at definition on a rendered `parameters` command: rename the native flag; the config property can keep its name.
