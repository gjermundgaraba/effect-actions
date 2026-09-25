# Context

Vocabulary and seams for `@gjermundgaraba/effect-actions`. The docs, the code, and the tests
use these words with these meanings.

## Terms

- **Action**: one contract. A name, a description, an input schema, a success schema, declared error schemas, authorization metadata (`access`), and MCP metadata (`mcp`). Holds no behavior. Made by `Action.make`.
- **Access**: `"read"` or `"write"`, required on every action and kept as a literal. States what the action does to its resource. Authorization metadata read by a pre-handler hook, independent of the MCP `readOnly` hint, which defaults from it.
- **Fields**: a record of service-free schemas, accepted wherever an action takes a struct schema: `input: { id: Schema.String }` is `input: Schema.Struct({ id: Schema.String })`.
- **Contracts**: the actions a binding or catalog covers: a list, with names unique within it.
- **Handler**: a function from decoded input to an Effect of decoded success, failing only with the action's declared errors, possibly requiring services.
- **Implementation**: actions bound to their handlers, one per `Action.implement` call. Nominal. Adapters take an implementation or a list and serve all of its actions; `ActionCatalog` and `ActionHttp.make` take contracts.
- **Builder**: the Effect passed to `implement` instead of a plain handler or record. It runs once per host, however many adapters serve its implementation: [guarantees.md](guarantees.md#dependency-lifetimes).
- **Guard**: `{ errors, before }`, bound as it is to every surface. `before`, the pre-handler hook, receives the selected action contract before its handler. What each surface reads of it, and when it runs: [guarantees.md](guarantees.md#dependency-lifetimes).
- **Build-time requirement**: a service yielded in a builder. Resolved when the host's layers are built.
- **Request-time requirement**: a service yielded inside a handler. Supplied per invocation: by router middleware for HTTP-hosted adapters, by the host for Toolkit, CLI, and stdio.
- **Adapter** (also **projection**): a module that maps implementations or contracts onto one surface: `ActionHttp`, `ActionMcp`, `ActionToolkit`, `ActionCli`, `ActionCatalog`. Each adapter reads only what it serves and validates only the names it serves.
- **Binding**: the value an adapter returns before anything runs. `ActionHttp.make` returns the HTTP binding (`actions`, `errors`, `prefix`, `schemaError`, `api`), data shared by the server and every client, which `ActionHttp.layer` serves; `ActionToolkit.make` returns the Toolkit binding (`toolkit`, `layer`).
- **Declared error**: an error schema listed on an action. Handlers may fail with it. HTTP encodes it with its `httpApiStatus`; MCP returns encoded error text in an `isError` result. Toolkit returns a native failure result, and CLI fails its command Effect without serializing the error.
- **Surface error**: an error declared on a surface rather than on an action: an HTTP binding's or a tool surface's `errors`. Produced by middleware around the surface, by its hook, or, over HTTP, by `schemaError` answering a request that does not decode or a result that does not encode; never by a handler. Declared so typed callers decode it.
- **Tool**: the MCP or Toolkit projection of an action, named after it and carrying its `mcp` hints.
- **Endpoint**: one `ActionMcp.layerHttp` mount. One route, one middleware set, one tool registry.
- **Document**: the OpenAPI output of `Http.api`, produced by Effect (`OpenApi.fromApi`) and served by `ActionHttp.openApi`.
- **Client**: `ActionHttpClient.make(Http)`, the native `HttpApiClient` as one method per action taking the action's input directly; the argument may be omitted when `{}` is a valid input. The **Promise client**, `ActionHttpClient.promise(Http)`, is the same for code that does not run Effects; it rejects with what the native client fails with.
- **Catalog**: the offline JSON description of contracts produced by `ActionCatalog.make`, with standalone JSON Schemas for encoded values. Descriptive only.
- **Identity**: the per-request principal, provided by `Authentication.middleware` under an application-owned tag. Never provided at startup.

## Seams

- `src/Action.ts` holds contracts and `implement`. It imports nothing transport-specific and knows nothing about HTTP, MCP, or the CLI.
- `src/internal/actions.ts` and `src/internal/implementation.ts` hold the shared shapes adapters consume: name checks, schema-error answers, the nominal `Implementation` class, builders as memoized layers, and dispatch. `src/internal/client.ts` builds the one client `ActionHttpClient`, remote `ActionCli` commands and `Testing` share. Everything under `src/internal` is not public API; the public modules re-export the types consumers need.
- Each adapter owns its own mapping from contracts to its surface and never reaches into another adapter. HTTP does not know about tool names; MCP does not know about routes.
- Adapters build on Effect's own servers and clients: `HttpApi` for HTTP, `McpServer` for MCP, `Toolkit` for the AI toolkit, `Command` for the CLI. The library adds no protocol runtime and defines no application error types.
- Authentication is router middleware plus discovery metadata. Verification, login, and consent stay in the application. Authorization is the application's guard, bound to each surface, which the library runs but never writes.
- Docs: `README.md` is the pitch for humans. `docs/` is the reference for agents, one card per module. `skills/effect-actions` is a copy of `docs/`, with this vocabulary included. `CONTRIBUTING.md` and `AGENTS.md` are for maintainers.
