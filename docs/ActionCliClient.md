# ActionCliClient

Native Effect CLI commands that call the HTTP API through Effect's `HttpApiClient`. Runs no
handler locally and manages no credentials.

## API

```ts
import * as ActionCliClient from "@gjermundgaraba/effect-actions/ActionCliClient";

/** One HTTP-enabled action retained by the binding. */
const command: <const Groups, const GroupName, const ActionName, Parameters = never>(
  http: Http<Groups>,
  groupName: GroupName,
  actionName: ActionName, // only actions with http: true
  options?: Options<SuccessType, Parameters>,
) => Command.Command<string, never, {}, ClientErrors, HttpClient.HttpClient | ClientServices>;

/** Every HTTP-enabled action of one group under the group name. */
const group: <const Groups, const GroupName>(
  http: Http<Groups>,
  groupName: GroupName,
  options?: GroupOptions,
) => Command.Command<string, {}, {}, ClientErrors, HttpClient.HttpClient | ClientServices>;

type Options<Output, Parameters> = ActionCli.Options<Output, Parameters> & {
  /** Passed directly to HttpApiClient.make: baseUrl, transformClient, transformResponse. */
  readonly connection?: Parameters<typeof HttpApiClient.make>[1];
};

interface GroupOptions {
  readonly name?: string;
  readonly connection?: Parameters<typeof HttpApiClient.make>[1]; // shared by every action
}
```

Parsing and rendering options (`name`, `render`, `parameters`, `input`) are the same as
[ActionCli.md](ActionCli.md).

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
  Effect.provide(NodeHttpClient.layerUndici), // the host supplies HttpClient
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

Authentication: `connection: { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)) }`.

## Rules

- Selectors resolve from `http.groups` only. `groupName` must be a bound group; `actionName` must be an action of that group with `http: true`. Runtime guards reject dynamically supplied strings that the types would not accept.
- The host provides `HttpClient` and its configuration. Endpoint selection, credentials, and storage are the host's; nothing is inferred from action arguments.
- Input is decoded by the action schema before dispatch, then passed to the native client at its normal codec boundary. Do not pre-encode values.
- Output is validated and printed as JSON, or through `render` with `--json` available, exactly as in `ActionCli`.
- Errors are the client's: declared errors, policy errors, `SchemaError`, and `HttpClientError`.

## Failure modes

- Type error on `actionName`: the action is `http: false`, or the group is not bound in this `Http`.
- `HttpClient` missing at runtime: provide `NodeHttpClient.layerUndici` (or `FetchHttpClient.layer`) to the runtime.
- Connection refused: `connection.baseUrl` is absent or wrong. It has no default.
- 401 from the server: add `transformClient` to `connection`. The command adds no headers on its own.
