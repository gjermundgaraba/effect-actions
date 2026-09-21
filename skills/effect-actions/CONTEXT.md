# Context

Vocabulary and seams for `@gjermundgaraba/effect-actions`. The docs, the code, and the tests
use these words with these meanings.

## Terms

- **Action**: one contract. A name, a description, an input schema, a success schema, declared error schemas, authorization metadata (`access`), and transport metadata (`http`, `mcp`). Holds no behavior. Made by `Action.make`.
- **Access**: `"read"` or `"write"`, required on every action and kept as a literal. States what the action does to its resource. Authorization metadata read by a pre-handler hook, independent of the MCP `readOnly` hint, which defaults from it.
- **Group**: a named, ordered set of actions plus group-level errors and an optional schema-error policy. Adapters serve groups, clients are organized by group, and the group name is the OpenAPI tag. Made by `ActionGroup.make`.
- **Contract**: an action or a group. Pure data; safe to import anywhere, including browsers.
- **Handler**: a function from decoded input to an Effect of decoded success, failing only with the action's declared errors, possibly requiring services.
- **Implementation**: a nominal binding of a complete handler record to a group, made by `group.implement`. Carries build-time error and requirement channels. Adapters accept implementations; `ActionCatalog` accepts contracts.
- **Builder**: the record or Effect passed to `implement`. Runs once per adapter layer that serves the implementation.
- **Pre-handler hook**: the `before` function an adapter binds. Runs once per invocation of that surface, with the selected action contract, before its handler. Fails with the surface's own errors. Its services are request-time requirements.
- **Build-time requirement**: a service yielded in the builder. Resolved when an adapter layer is built.
- **Request-time requirement**: a service yielded inside a handler. Supplied per invocation: by router middleware for HTTP-hosted adapters, by the host for Toolkit, CLI, and stdio.
- **Adapter** (also **projection**): a module that maps implementations or contracts onto one surface: `ActionHttp`, `ActionMcp`, `ActionToolkit`, `ActionCli`, `ActionCliClient`, `ActionCatalog`. Each adapter reads only what it serves and validates only its own namespace.
- **Binding**: the value an adapter returns before anything runs. `ActionHttp.make` returns the HTTP binding (`groups`, `api`, `layer`); `ActionToolkit.make` returns the Toolkit binding (`toolkit`, `layer`).
- **Contract map**: the record `ActionGroup.contracts` returns, keyed `<group>.<action>`, with each action's exact type. The shared identity of an action across routes, tools and commands.
- **Declared error**: an error schema listed on an action or inherited from its group. Handlers may fail with it. Encoded on every transport with its `httpApiStatus`.
- **Schema-error policy**: a group option mapping Effect's `HttpApiSchemaError` (decode or encode failure) to a declared policy error with a status. HTTP only.
- **Policy error**: an error a schema-error policy may answer with. Part of the transport contract, never returnable by a handler.
- **Surface error**: an error declared on an adapter binding rather than on an action. Produced by middleware around the surface or by its pre-handler hook, never by a handler; declared so typed callers decode it.
- **Local-only action**: `http: false` and `mcp: false`. Reachable through `ActionCli` and listed in the catalog.
- **Tool**: the MCP or Toolkit projection of an MCP-enabled action, named by `mcp.name` and carrying its hints.
- **Endpoint**: one `ActionMcp.layerHttp` mount. One route, one middleware set, one tool registry.
- **Document**: the OpenAPI output of `Http.api`, produced by Effect (`OpenApi.fromApi`).
- **Catalog**: the offline JSON description of groups produced by `ActionCatalog.make`. Descriptive only.
- **Identity**: the per-request principal, provided by `Authentication.middleware` under an application-owned tag. Never provided at startup.

## Seams

- `src/Action.ts` and `src/ActionGroup.ts` are contracts. They import nothing transport-specific and know nothing about HTTP, MCP, or the CLI.
- `src/internal/actions.ts` and `src/internal/implementation.ts` hold the shared shapes adapters consume: the contract half of a group, the schema-error policy, and the nominal `Implementation` class. Everything under `src/internal` is not public API; the public modules re-export the types consumers need.
- Each adapter owns its own mapping from contracts to its surface and never reaches into another adapter. HTTP does not know about tool names; MCP does not know about routes.
- Adapters build on Effect's own servers and clients: `HttpApi` for HTTP, `McpServer` for MCP, `Toolkit` for the AI toolkit, `Command` for the CLI. The library adds no protocol runtime and defines no application error types.
- Authentication is router middleware plus discovery metadata. Verification, login, and consent stay in the application. Authorization is the application's pre-handler hook, bound to each surface, which the library runs but never writes.
- `Testing` depends only on `effect`. `TestingClient` is the single module that loads the optional MCP client peer.
- Docs: `README.md` is the pitch for humans. `docs/` is the reference for agents, one card per module. `skills/effect-actions` is a copy of `docs/`, with this vocabulary included. `CONTRIBUTING.md` and `AGENTS.md` are for maintainers.
