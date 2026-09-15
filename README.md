# @gjermundgaraba/effect-actions

Define an Effect action once, implement it once, expose it over **HTTP and MCP**.

**Experimental release candidate.** The repository currently uses Effect snapshot
[`4e4a3a6`](https://pkg.pr.new/Effect-TS/effect/effect@4e4a3a6). The MCP adapter
requires APIs missing from published `4.0.0-rc.115`, despite that being the current
peer declaration. Until these versions are aligned, use the pinned snapshot;
the declared peer version alone is not sufficient.

## Quickstart

```ts
import { Effect, Layer, Schema } from "effect";
import { Action, ActionGroup, ActionHttp, ActionMcp } from "@gjermundgaraba/effect-actions";

const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  mcp: { readOnly: true },
});

export const Actions = ActionGroup.make(Greet);
const app = Actions.implement({
  greet: ({ name }) => Effect.succeed(`Hello, ${name}!`),
});

export const routes = Layer.mergeAll(
  ActionHttp.layer(app),
  ActionMcp.layer(app, { name: "greetings", version: "1.0.0" }),
);
```

Serve `routes` with Effect's `HttpRouter`. This creates `POST /api/actions/greet`,
`GET /openapi.json`, and an MCP endpoint at `/mcp`. The HTTP response is
`"Hello, Ada!"`; MCP returns `structuredContent: { value: "Hello, Ada!" }`.
See [examples/server.ts](examples/server.ts) for Node server wiring and the
[authenticated demo](examples/README.md) for a runnable application.

### Contracts

- `input` defaults to `Action.NoInput` for actions without arguments.
- `error` is a list of failure schemas, defaulting to none. Each schema retains
  its own `httpApiStatus` annotation.
- Actions default to both transports; use `http: false` or `mcp: false` to opt out.
- MCP input must have an object-root JSON Schema; declared errors must encode to
  objects. The MCP adapter checks this at Layer construction. HTTP allows scalars.
- `mcp.name` overrides the tool name. `destructive` defaults to `!readOnly`.
- Schemas must be service-free. Handlers may require services.

## HTTP client

```ts
import { Effect } from "effect";
import { ActionHttp } from "@gjermundgaraba/effect-actions";
import { Actions } from "./contracts.js";

export const lookup = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Actions, {
    baseUrl: "https://api.example.com",
  });
  const user = yield* client.getUser({ id: "1" });
  const identity = yield* client.whoAmI();
  return { user, identity };
});
```

Supply an Effect `HttpClient`, such as `FetchHttpClient.layer`. Methods take decoded
inputs and return decoded results; MCP-only actions are excluded. Authentication
headers can be added with `transformClient`. See [client details](docs/behavior.md#http-client-details)
for error types, optional inputs, and native grouped clients.

## Adapter options

| API                          | Options                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `ActionHttp.layer`           | `prefix`, `openapiPath`, `schemaError`                                                  |
| `ActionHttp.api` / `openapi` | `prefix`, `schemaError`                                                                 |
| `ActionHttp.client`          | `prefix`, `schemaError`, `baseUrl`, `transformClient`, `transformResponse`              |
| `ActionMcp.layer`            | `name`, `version`, `path`, `protocols`, `allowedOrigins`, `instructions`, `schemaError` |

`ActionHttp.configure(options)` binds HTTP configuration for its `layer`, `api`,
`openapi`, and `client` methods. Configured clients accept only connection options.
Set `openapiPath: false` when the host serves a combined document.

See [adapter behavior](docs/behavior.md) for shared schema-error policies,
dependency lifetimes, wire formats, and MCP protocol support.

## Scope

HTTP means JSON POST endpoints, not Effect's RPC wire protocol. Both adapters use
Effect's servers; there is no MCP SDK runtime dependency. Actions are unary:
no streaming, uploads, prompts, resources, or retries.

Authentication and authorization belong to the application. Tool discovery is
not filtered by actor. The example's bearer tokens are **demo-only**; production
needs real token validation, MCP authorization discovery, request limits, and
error reporting.

## Development and packaging

Requires a supported Node.js version (24 LTS recommended) and [Vite+](https://viteplus.dev).

```sh
vp install
vp check
vp test
vp run test:package
vp run example
```

`vp run dev` watches the library build. `vp check` also verifies the compile-time
assertions in `tests/types.ts`. Tests cover both transports, official MCP clients,
context isolation, schema-error policies, and cancellation.

`vp run build` emits ESM and declarations into `dist/`. Public entry points are the
package root, `/Action`, `/ActionGroup`, `/http`, and `/mcp`.
`vp run test:package` builds and checks a tarball in an isolated consumer using the pinned
Effect snapshot; it does not establish compatibility with the published peer.

Before publishing to npm, align the Effect development and peer versions with a
published release containing the required APIs and rerun all checks above.
