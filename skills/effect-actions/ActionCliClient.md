# ActionCliClient

Native Effect CLI commands that call the HTTP API through Effect's `HttpApiClient`. Runs no
handler locally and manages no credentials.

## API

Import `@gjermundgaraba/effect-actions/ActionCliClient`.

| API                                              | Purpose                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `command(http, groupName, actionName, options?)` | Call one action of the binding through a native Effect `Command`.          |
| `group(http, groupName, options?)`               | Every action of a bound group under one command.                           |
| `Options`, `GroupOptions`, `Connection`          | Single/aggregate command configuration and native HTTP connection options. |

Single-command options: `name`, `render`, paired `parameters`/`input`, and `connection`.
Group options: `name` and `connection`. Parsing/rendering semantics match [ActionCli.md](ActionCli.md).
`connection` accepts native `HttpApiClient.make` configuration, including `baseUrl`,
`transformClient` and `transformResponse`.

Remote commands have no local `before` hook: the server owns authorization. Their Effects
retain the selected endpoint's client failures and middleware requirements, and require an
`HttpClient` supplied by the host. Group/action selectors stay checked against the bound API.

## Canonical

```ts
import { Command } from "effect/cli";
import { Console, Effect, Logger } from "effect";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCliClient from "@gjermundgaraba/effect-actions/ActionCliClient";
import { Http } from "./contracts.js";

const command = ActionCliClient.command(Http, "public", "status", {
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

- Selectors resolve from `http.groups` only. `groupName` must be a bound group; `actionName` must be an action of that group. Runtime guards reject dynamically supplied strings that the types would not accept.
- The host provides `HttpClient` and its configuration. Endpoint selection, credentials, and storage are the host's; nothing is inferred from action arguments.
- Input (`--input`, `--input-file`, or `input(parsed)`) is encoded JSON. The command decodes it with the action schema, and the native client re-encodes it with `Http.api`'s closed payload codec.
- Input syntax (`--input`, `--input-file`, or `parameters`) and output (`render` and its `--json` flag) are exactly as in `ActionCli`.
- Errors are the client's: declared errors (the binding's `errors` included), policy errors, `SchemaError`, and `HttpClientError`.

## Failure modes

- Type error on `actionName`: the action is not in that group, or the group is not bound in this `Http`.
- `HttpClient` unsatisfied (a type error at `runMain`): provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`) to the runtime.
- `HttpClientError` with `reason._tag` `InvalidUrlError`: `connection.baseUrl` is absent; it has no default. Connection refused: `baseUrl` points at the wrong host or port.
- 401 from the server: add `transformClient` to `connection`. The command adds no headers on its own.
