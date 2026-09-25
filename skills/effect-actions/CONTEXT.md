# Context

Vocabulary and seams for `@gjermundgaraba/effect-actions`. The docs, the code, and the tests
use these words with these meanings.

## Terms

- **Action**: one contract. A name, a description, an input schema, a success schema, declared error schemas, authorization metadata (`access`), and MCP metadata (`mcp`). Holds no behavior. Made by `Action.make`.
- **Access**: `"read"` or `"write"`, required on every action and kept as a literal. States what the action does to its resource. Authorization metadata read by a pre-handler hook, independent of the MCP `readOnly` hint, which defaults from it.
- **Fields**: a record of service-free schemas, accepted wherever an action takes a struct schema: `input: { id: Schema.String }` is `input: Schema.Struct({ id: Schema.String })`.
- **Contracts**: the actions a binding or catalog covers: a list, with names unique within it.
- **Handler**: a function from decoded input to an Effect of decoded success, failing only with the action's declared errors, possibly requiring services.
- **Implementation**: one action bound to its handler, made by `Action.implement`, which returns a list of them, one per action. Nominal. Adapters take lists of implementations; `ActionCatalog` and `ActionHttp.make` take contracts.
- **Builder**: the Effect passed to `implement` instead of a plain handler or record. Every implementation one `implement` call returns shares it. When it runs: [guarantees.md](guarantees.md#dependency-lifetimes).
- **Pre-handler hook**: the `before` function a surface binds. Receives the selected action contract before its handler and fails with the surface's own errors. When it runs: [guarantees.md](guarantees.md#dependency-lifetimes).
- **Build-time requirement**: a service yielded in a builder. Resolved when an adapter layer is built.
- **Request-time requirement**: a service yielded inside a handler. Supplied per invocation: by router middleware for HTTP-hosted adapters, by the host for Toolkit, CLI, and stdio.
- **Adapter** (also **projection**): a module that maps implementations or contracts onto one surface: `ActionHttp`, `ActionMcp`, `ActionToolkit`, `ActionCli`, `ActionCliClient`, `ActionCatalog`. Each adapter reads only what it serves and validates only the names it serves.
- **Binding**: the value an adapter returns before anything runs. `ActionHttp.make` returns the HTTP binding (`actions`, `errors`, `api`, `layer`, `openApi`), shared by the server and every client; `ActionToolkit.make` returns the Toolkit binding (`toolkit`, `layer`).
- **Declared error**: an error schema listed on an action. Handlers may fail with it. HTTP encodes it with its `httpApiStatus`; MCP returns encoded error text in an `isError` result. Toolkit returns a native failure result, and CLI fails its command Effect without serializing the error.
- **Schema-error policy**: an HTTP binding option answering Effect's `HttpApiSchemaError` with a declared policy error and its status: `invalid` when the request did not decode, `internal` when the handler's result did not encode. The library decides which applies. HTTP only.
- **Policy error**: an error a schema-error policy may answer with. Part of the transport contract, never returnable by a handler.
- **Surface error**: an error declared on an adapter binding rather than on an action. Produced by middleware around the surface or by its pre-handler hook, never by a handler; declared so typed callers decode it.
- **Tool**: the MCP or Toolkit projection of an MCP-enabled action, named by `mcp.name` and carrying its hints.
- **Endpoint**: one `ActionMcp.layerHttp` mount. One route, one middleware set, one tool registry.
- **Document**: the OpenAPI output of `Http.api`, produced by Effect (`OpenApi.fromApi`) and served by `Http.openApi`.
- **Client**: `ActionHttpClient.make(Http)`, the native `HttpApiClient` as one method per action taking the action's input directly; the argument may be omitted when `{}` is a valid input. The **Promise client**, `ActionHttpClient.promise(Http)`, is the same for code that does not run Effects; it rejects with what the native client fails with.
- **Catalog**: the offline JSON description of contracts produced by `ActionCatalog.make`, with standalone JSON Schemas for encoded values. Descriptive only.
- **Identity**: the per-request principal, provided by `Authentication.middleware` under an application-owned tag. Never provided at startup.

## Seams

- `src/Action.ts` holds contracts and `implement`. It imports nothing transport-specific and knows nothing about HTTP, MCP, or the CLI.
- `src/internal/actions.ts` and `src/internal/implementation.ts` hold the shared shapes adapters consume: name checks, the schema-error policy, the nominal `Implementation` class, builder acquisition and dispatch. `src/internal/client.ts` builds the one client `ActionHttpClient`, `ActionCliClient` and `Testing` share. Everything under `src/internal` is not public API; the public modules re-export the types consumers need.
- Each adapter owns its own mapping from contracts to its surface and never reaches into another adapter. HTTP does not know about tool names; MCP does not know about routes.
- Adapters build on Effect's own servers and clients: `HttpApi` for HTTP, `McpServer` for MCP, `Toolkit` for the AI toolkit, `Command` for the CLI. The library adds no protocol runtime and defines no application error types.
- Authentication is router middleware plus discovery metadata. Verification, login, and consent stay in the application. Authorization is the application's pre-handler hook, bound to each surface, which the library runs but never writes.
- `Testing` depends only on `effect`. `TestingClient` is the single module that loads the optional MCP client peer.
- Docs: `README.md` is the pitch for humans. `docs/` is the reference for agents, one card per module. `skills/effect-actions` is a copy of `docs/`, with this vocabulary included. `CONTRIBUTING.md` and `AGENTS.md` are for maintainers.
