# ActionCliClient

Native Effect CLI commands that call the HTTP API through `ActionHttpClient`. Runs no handler
locally and manages no credentials.

## API

Import `@gjermundgaraba/effect-actions/ActionCliClient`.

| API                                    | Purpose                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `command(http, action, options?)`      | Call one action of the binding, selected by its contract, as a `Command`. |
| `make(http, options)`                  | Every action of the binding under one named aggregate command.            |
| `Options`, `MakeOptions`, `Connection` | Single/aggregate command configuration and client options.                |

Single-command options: `name`, `render`, paired `parameters`/`input`, and `connection`.
Aggregate options: `name` (required) and `connection`. Parsing/rendering semantics match
[ActionCli.md](ActionCli.md). `connection` is `ActionHttpClient.Options`: `baseUrl` and
`transformClient`.

Remote commands have no local `before` hook: the server owns authorization. A command fails
with exactly what the action's `ActionHttpClient` method fails with, and requires an
`HttpClient` supplied by the host.

## Canonical

```ts
import { Command } from "effect/unstable/cli";
import { Console, Effect, Logger } from "effect";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCliClient from "@gjermundgaraba/effect-actions/ActionCliClient";
import { Http, Status } from "./contracts.js";

const command = ActionCliClient.command(Http, Status, {
  connection: { baseUrl: "http://127.0.0.1:3000" },
});

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  // The host supplies the native client and its connection configuration.
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

Authentication: `connection: { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)) }`.

## Rules

- `command(http, action)` takes the contract itself, one of the binding's actions, checked at the type level and again at runtime by object identity. It calls that action's route, `<prefix>/<action>`, through the action's `ActionHttpClient` method.
- `make(http, { name })` projects every action of the binding as one subcommand (`cli greet`), the same tree `ActionCli.make` builds locally. Subcommands use the default JSON syntax; compose `command` results with native `Command` combinators for a custom tree.
- The host provides `HttpClient` and its configuration. Credentials and storage are the host's; nothing is inferred from action arguments.
- The action is the command's own: nothing in `connection` selects another endpoint.
- Input is decoded by the action schema before dispatch, then passed to the native client at its normal codec boundary. Do not pre-encode values.
- Input syntax (`--input`, `--input-file`, or `parameters`) and output (`render` and its `--json` flag) are exactly as in `ActionCli`.
- Errors are the client's: the action's declared errors, the binding's surface and policy errors, `SchemaError`, and `HttpClientError`.

## Failure modes

- Type error at `command`, or `Action "x" is not in this HTTP binding` thrown: the action was not passed to this binding's `ActionHttp.make`. Select with the exact contract value the binding received; an equal-looking action does not match.
- `HttpClient` missing at runtime: provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`) to the runtime.
- Connection refused: `connection.baseUrl` is absent or wrong. It has no default.
- 401 from the server: add `transformClient` to `connection`. The command adds no headers on its own.
- `HttpClientError` with a decode error on a status the server does answer: that status's error is declared neither on the action nor in the binding's `errors`. Declare it on `ActionHttp.make`.
