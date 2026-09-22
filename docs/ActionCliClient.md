# ActionCliClient

Native Effect CLI commands that call the HTTP API through Effect's `HttpApiClient`. Runs no
handler locally and manages no credentials.

## API

```ts
import * as ActionCliClient from "@gjermundgaraba/effect-actions/ActionCliClient";

/** One HTTP-enabled action retained by the binding. */
const command: <
  const Groups,
  const Errors,
  const GroupName,
  const ActionName,
  ParsedParameters = never,
>(
  http: Http<Groups, Errors>,
  groupName: GroupName,
  actionName: ActionName, // only actions with http: true
  options?: Options<SuccessType, ParsedParameters>,
) => Command.Command<string, never, {}, ClientErrors, HttpClient.HttpClient | ClientServices>;

/** Every HTTP-enabled action of one group under the group name. */
const group: <const Groups, const Errors, const GroupName>(
  http: Http<Groups, Errors>,
  groupName: GroupName,
  options?: GroupOptions,
) => Command.Command<string, {}, {}, ClientErrors, HttpClient.HttpClient | ClientServices>;
```

### Options

```ts
import type { Schema } from "effect";
import type { Command } from "effect/unstable/cli";
import type { HttpApiClient } from "effect/unstable/httpapi";

/** Native client configuration: baseUrl, transformClient, transformResponse. */
export type Connection = NonNullable<Parameters<typeof HttpApiClient.make>[1]>;

/** Remote commands have no local `before` hook. */
export type Options<Output, ParsedParameters extends Command.Command.Config = never> = {
  readonly name?: string;
  readonly render?: (output: Output) => string;
  readonly connection?: Connection;
} & (
  | { readonly parameters?: never; readonly input?: never }
  | {
      readonly parameters: ParsedParameters;
      readonly input: (parsed: Command.Command.Config.InferValue<ParsedParameters>) => Schema.Json;
    }
);

export interface GroupOptions {
  readonly name?: string;
  readonly connection?: Connection;
}
```

Parsing and rendering options (`name`, `render`, `parameters`, `input`) are the same as
[ActionCli.md](ActionCli.md). Remote commands have no `before` hook: the server owns authorization.

## Canonical

```ts
import { Command } from "effect/unstable/cli";
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

- Selectors resolve from `http.groups` only. `groupName` must be a bound group; `actionName` must be an action of that group with `http: true`. Runtime guards reject dynamically supplied strings that the types would not accept.
- The host provides `HttpClient` and its configuration. Endpoint selection, credentials, and storage are the host's; nothing is inferred from action arguments.
- Input is decoded by the action schema before dispatch, then passed to the native client at its normal codec boundary. Do not pre-encode values.
- Input syntax (`--input`, `--input-file`, or `parameters`) and output (`render` and its `--json` flag) are exactly as in `ActionCli`.
- Errors are the client's: declared errors, policy errors, `SchemaError`, and `HttpClientError`.

## Failure modes

- Type error on `actionName`: the action is `http: false`, or the group is not bound in this `Http`.
- `HttpClient` missing at runtime: provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`) to the runtime.
- Connection refused: `connection.baseUrl` is absent or wrong. It has no default.
- 401 from the server: add `transformClient` to `connection`. The command adds no headers on its own.
