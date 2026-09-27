---
name: effect-actions
description: >
  Reference for @gjermundgaraba/effect-actions. Use when defining Effect action contracts
  and implementations (Action), authenticating and authorizing them, serving them over HTTP
  or MCP, projecting them into an Effect AI Toolkit or a CLI, calling an ActionHttp binding
  with its client, or testing those surfaces in memory.
---

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

| Read                                   | When you need to                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [setup.md](setup.md)                   | install, pin versions, pick entry points, bundle a browser client, know what the package does not do      |
| [Action.md](Action.md)                 | define a contract (input, success, errors, access, hints), bind its handler and hook, built-in errors     |
| [ActionHttp.md](ActionHttp.md)         | serve JSON POST routes, answer bad input, publish OpenAPI, call the API with one Effect method per action |
| [ActionMcp.md](ActionMcp.md)           | serve MCP tools over Streamable HTTP (2026-07-28) or stdio (2026-07-28, 2025-11-25, 2025-06-18)           |
| [ActionToolkit.md](ActionToolkit.md)   | use actions as a native Effect AI `Toolkit` without a server                                              |
| [ActionCli.md](ActionCli.md)           | run handlers in-process, or call the HTTP API, from a command with derived flags                          |
| [Authentication.md](Authentication.md) | authenticate the callers of HTTP surfaces, refuse with 401/403, publish RFC 9728 discovery                |
| [Testing.md](Testing.md)               | call routes and tools in memory through `HttpClient`                                                      |
| [guarantees.md](guarantees.md)         | cross-cutting rules: builder lifetimes, wire formats, spans, request context, scope                       |

## Choose a surface

- Callers speak JSON over HTTP: `ActionHttp`. Clients use `ActionHttp.client(Http)`.
- Callers are MCP clients: `ActionMcp.layerHttp` for a hosted endpoint, `ActionMcp.layerStdio` for a subprocess.
- Callers are an Effect AI program in the same process: `ActionToolkit`.
- Callers are humans or scripts in a terminal: `ActionCli`, from implementations to run handlers locally, or from the HTTP binding to call a server.

Every surface that runs handlers takes the same implementations (`Action.implement(...)`), one or a list, with options last. An implementation carries its own `before` hook, which every surface runs; surfaces take only their transport's options. Authentication is router middleware the host provides around the HTTP surfaces.

## Minimal program

```ts
import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

// The contract and its HTTP binding import no server code, so any client can import them,
// a browser page included.
export const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: { name: Schema.String },
  success: Schema.String,
  access: "read",
});

export const Http = ActionHttp.make([Greet]);
```

The server, in its own module, so that a browser client imports the contract alone:

```ts
import { Effect, Layer } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Greet, Http } from "./quickstart.js";

const greet = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));

export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greet),
  ActionMcp.layerHttp(greet, { name: "greetings", version: "1.0.0" }),
);
```

Serve `routes` with `HttpRouter.serve` and a platform server layer. Result: `POST /api/greet` and an MCP tool `greet` at `/mcp`.

## Runnable examples

Repository directory `examples/`: the minimal program, an authenticated application served on
every surface, and one file per other surface, each listed in its
[README](https://github.com/gjermundgaraba/effect-actions/tree/main/examples#readme).
