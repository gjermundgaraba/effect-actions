# effect-actions reference

Reference for `@gjermundgaraba/effect-actions`, written for coding agents. Every page is a
card with the same sections: **API** (inventory and options), **Canonical** (the one right way to write
it), **Rules** (must and never), **Failure modes** (what you see when it is wrong, and the fix).
Read the card for a module before writing code that uses it. Exported TypeScript declarations are the exact signature reference. Vocabulary is defined in
[CONTEXT.md](CONTEXT.md); the pages use those terms exactly.

Package facts that apply everywhere:

- Every module is a subpath import: `import * as Action from "@gjermundgaraba/effect-actions/Action"`. There is no package root.
- The `effect` peer accepts any 4.0 release candidate from `4.0.0-rc.116` on (`>=4.0.0-rc.116 <4.0.0`). The package is built and tested against `4.0.0-rc.117`.
- Actions are pure values. Nothing runs, binds, or acquires services until a surface's layer is built.

## Pages

| Read                                       | When you need to                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [setup.md](setup.md)                       | install, pin versions, pick entry points, know what the package does not do                  |
| [Action.md](Action.md)                     | define a contract (input, success, errors, access, hints), bind its handler, built-in errors |
| [ActionHttp.md](ActionHttp.md)             | serve JSON POST routes, answer bad input, publish OpenAPI                                    |
| [ActionHttpClient.md](ActionHttpClient.md) | call the HTTP API: one Effect method per action                                              |
| [ActionMcp.md](ActionMcp.md)               | serve MCP 2026-07-28 tools over Streamable HTTP or stdio                                     |
| [ActionToolkit.md](ActionToolkit.md)       | use actions as a native Effect AI `Toolkit` without a server                                 |
| [ActionCli.md](ActionCli.md)               | run handlers in-process, or call the HTTP API, from a command with derived flags             |
| [Authentication.md](Authentication.md)     | provide a per-request identity, refuse with 401/403, publish RFC 9728 discovery              |
| [Testing.md](Testing.md)                   | call routes and tools in memory through `HttpClient`                                         |
| [guarantees.md](guarantees.md)             | cross-cutting rules: builder lifetimes, wire formats, spans, request context, scope          |

## Choose a surface

- Callers speak JSON over HTTP: `ActionHttp`. Clients use `ActionHttpClient.make(Http)`.
- Callers are MCP clients: `ActionMcp.layerHttp` for a hosted endpoint, `ActionMcp.layerStdio` for a subprocess.
- Callers are an Effect AI program in the same process: `ActionToolkit`.
- Callers are humans or scripts in a terminal: `ActionCli`, from implementations to run handlers locally, or from the HTTP binding to call a server.

Every surface that runs handlers takes the same implementations (`Action.implement(...)`), one or a list, with options last, and the same `{ before }` hook.

## Minimal program

```ts
import { Effect, Layer, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

export const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: { name: Schema.String },
  success: Schema.String,
  access: "read",
});

export const Http = ActionHttp.make([Greet]);

const greet = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));

export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greet),
  ActionMcp.layerHttp(greet, { name: "greetings", version: "1.0.0" }),
);
```

Serve `routes` with `HttpRouter.serve` and a platform server layer. Result: `POST /api/greet` and an MCP tool `greet` at `/mcp`.

## Runnable examples

Repository directory `examples/` ([on GitHub](https://github.com/gjermundgaraba/effect-actions/tree/main/examples)):

- `quickstart.ts`, `quickstart-client.ts`: the minimal program and its typed client.
- `contracts.ts`, `binding.ts`, `handlers.ts`, `authorization.ts`, `authentication.ts`, `http.ts`, `mcp.ts`, `request-policy.ts`, `app.ts`, `server.ts`: an authenticated application with public and protected routes under separate middleware, one `before` hook on every surface, two MCP endpoints, OpenAPI and Swagger.
- `toolkit.ts`, `cli.ts`, `cli-remote.ts`, `mcp-stdio.ts`: one file per other surface.
- `mcp-browser.ts`: a stateless MCP endpoint with a separate browser CORS policy.
- `toolkit-authorized.ts`: native Toolkit invocation with authorization and correctly scoped identity.
- `testing.ts`: in-memory HTTP and MCP calls with cleanup.
