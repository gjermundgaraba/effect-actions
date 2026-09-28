# Context

Vocabulary for `@gjermundgaraba/effect-actions`. The docs, the code, and the tests use these
words with these meanings. Module names and Effect's own terms (`HttpApi`, `Tool`, `Toolkit`,
`McpServer`, `Command`) mean what their modules say.

## Terms

- **Action**: one contract. A name, a description, an input schema, a success schema, declared error schemas, `access`, and tool `hints`. Holds no behavior. Made by `Action.make`.
- **Access**: `"read"` or `"write"`, required on every action and kept as a literal. States what the action does to its resource. Read by an implementation's `before` hook, and the only source of a tool's read-only hint.
- **Handler**: a function from decoded input to an Effect of decoded success, failing only with the action's declared errors. The services it yields, and a `before` hook's, are **request-time requirements**, supplied per call: over HTTP by router middleware around the surface, authentication included; on a local surface by the host.
- **Implementation**: actions bound to their handlers and their `before` hook, one per `Action.implement` call. Nominal. Every surface that runs handlers takes an implementation or a list and serves all of its actions.
- **Builder**: the Effect passed to `implement` instead of a plain handler or record. It runs once per build of the host's layers, however many surfaces serve its implementation, and once per invocation of a local CLI command: [guarantees.md](guarantees.md#dependency-lifetimes). The services it yields are **build-time requirements**, resolved when the host's layers are built.
- **Host**: the application that serves the surfaces: it builds their layers, provides their services and middleware, and runs the server, subprocess or CLI.
- **Surface**: where callers reach actions: HTTP routes, an MCP endpoint, a Toolkit, a CLI command. Each serves the implementations passed to it and validates only the names it serves. A **local surface** has no remote caller (`ActionToolkit`, a local `ActionCli` command, `ActionMcp.runStdio`): nothing authenticates, and the host provides the identity.
- **Binding**: the value `ActionHttp.make` returns, `{ actions, errors, api }`, typed `ActionHttp.Binding`. Plain data shared by the server and every client; `ActionHttp.layer` serves it. No other surface has one.
- **`before` hook**: an Effectful function of the selected action, bound to an implementation and run by every surface serving it. It runs after input decoding and before the handler, and succeeds or fails with a refusal: [guarantees.md](guarantees.md#dependency-lifetimes).
- **Authentication**: router middleware the host provides around HTTP surfaces, such as `Authentication.make`: it establishes the caller's identity before decoding. Authorization is the `before` hook's.
- **Declared error**: an error schema listed on an action. Handlers may fail with it. HTTP sends its JSON encoding with its `httpApiStatus`, 422 without one; MCP returns the same JSON as an `isError` result; the Toolkit returns it as a failure result; the CLI fails its command Effect with it.
- **Built-in errors**: `Action.InvalidInput` (400), `Action.Unauthenticated` (401) and `Action.Forbidden` (403), tagged errors with body `{ _tag, message }` and a default `message`; a `Forbidden` may also name the OAuth `scopes` a call lacks. The library produces them, and every surface declares them: [guarantees.md](guarantees.md#wire-behavior).
- **Refusal**: `Action.Refusal`, `Unauthenticated | Forbidden`. What a `before` hook or authentication fails with instead of letting a handler run. A hook can fail with nothing else. A **step-up refusal** is one an OAuth client acts on, `Unauthenticated` or a `Forbidden` naming `scopes`: the HTTP surfaces answer it with its HTTP status and challenge, whoever fails with it ([guarantees.md](guarantees.md#dependency-lifetimes)).
