# Context

Vocabulary and seams for `@gjermundgaraba/effect-actions`. The docs, the code, and the tests
use these words with these meanings. Module names and Effect's own terms (`HttpApi`, `Tool`,
`Toolkit`, `McpServer`, `Command`) mean what their modules say.

## Terms

- **Action**: one contract. A name, a description, an input schema, a success schema, declared error schemas, `access`, and tool `hints`. Holds no behavior. Made by `Action.make`.
- **Access**: `"read"` or `"write"`, required on every action and kept as a literal. States what the action does to its resource. Read by an implementation's `before` hook, and the only source of a tool's read-only hint.
- **Handler**: a function from decoded input to an Effect of decoded success, failing only with the action's declared errors, possibly requiring services.
- **Implementation**: actions bound to their handlers and their policy (`authenticate`, `before`), one per `Action.implement` call. Nominal. Every surface that runs handlers takes an implementation or a list and serves all of its actions.
- **Builder**: the Effect passed to `implement` instead of a plain handler or record. It runs once per host, however many surfaces serve its implementation: [guarantees.md](guarantees.md#dependency-lifetimes).
- **Build-time requirement**: a service yielded in a builder. Resolved when the host's layers are built.
- **Request-time requirement**: a service yielded inside a handler or a `before` hook. Supplied per invocation: over HTTP by the implementation's `authenticate` or router middleware, by the host for the Toolkit, the CLI, and stdio.
- **Surface**: where callers reach actions: HTTP routes, an MCP endpoint, a Toolkit, a CLI command. Each serves the implementations passed to it and validates only the names it serves.
- **Binding**: the `Http` value `ActionHttp.make` returns, `{ actions, prefix, api }`. Plain data shared by the server and every client; `ActionHttp.layer` serves it. No other surface has one.
- **`before` hook**: an Effectful function of the selected action, bound to an implementation and run by every surface serving it. It runs after input decoding and before the handler, and succeeds or fails with a refusal: [guarantees.md](guarantees.md#dependency-lifetimes).
- **Declared error**: an error schema listed on an action. Handlers may fail with it. HTTP sends its JSON encoding with its `httpApiStatus`; MCP returns the same JSON as an `isError` result; the Toolkit returns it as a failure result; the CLI fails its command Effect with it.
- **Built-in errors**: `Action.InvalidInput` (400), `Action.Unauthenticated` (401) and `Action.Forbidden` (403), tagged errors with body `{ _tag, message }` and a default `message`. The library produces them, not handlers: every HTTP endpoint declares all three, every tool the two refusals, so every typed caller decodes them.
- **Refusal**: `Action.Refusal`, `Unauthenticated | Forbidden`. What a `before` hook or an implementation's `authenticate` fails with instead of letting a handler run. A hook can fail with nothing else.

## Seams

- `src/Action.ts` holds contracts, `implement`, and re-exports the built-in errors. It imports nothing transport-specific and knows nothing about HTTP, MCP, or the CLI.
- `src/internal/errors.ts` defines the built-in errors. `src/internal/actions.ts` and `src/internal/implementation.ts` hold the shared shapes the surfaces consume: name checks, the nominal `Implementation` class, builders as memoized layers, the policy (`authenticate` and the `before` hook), and dispatch. `src/internal/client.ts` builds the one client `ActionHttp.client` and remote `ActionCli` commands share. Everything under `src/internal` is not public API; the public modules re-export the types consumers need.
- Each surface owns its own mapping from actions to itself and never reaches into another. HTTP does not know about tool names; MCP does not know about routes.
- Surfaces build on Effect's own servers and clients: `HttpApi` for HTTP, `McpServer` for MCP, `Toolkit` for the AI toolkit, `Command` for the CLI. The library adds no protocol runtime.
- Authentication is router middleware an implementation names, which HTTP surfaces run, plus discovery metadata. Verification, login, and consent stay in the application. Authorization is the application's `before` hook, bound to the implementation, which the library runs but never writes.
- Docs: `README.md` is the pitch for humans. `docs/` is the reference for agents, one card per module. `skills/effect-actions` is a copy of `docs/`, with this vocabulary included. `CONTRIBUTING.md` and `AGENTS.md` are for maintainers.
