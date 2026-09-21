---
name: effect-actions
description: >
  Reference for @gjermundgaraba/effect-actions. Use when defining Effect action contracts
  (Action, ActionGroup), serving them over HTTP or MCP, projecting them into an Effect AI
  Toolkit or a CLI, exporting a catalog, wiring Authentication middleware, calling an
  ActionHttp binding with HttpApiClient, or testing those adapters in memory.
---

# effect-actions reference

Reference for `@gjermundgaraba/effect-actions`, written for coding agents. Every page is a
card with the same sections: **API** (signatures), **Canonical** (the one right way to write
it), **Rules** (must and never), **Failure modes** (what you see when it is wrong, and the fix).
Read the card for a module before writing code that uses it. Vocabulary is defined in
[CONTEXT.md](CONTEXT.md); the pages use those terms exactly.

Package facts that apply everywhere:

- Every module is a subpath import: `import * as Action from "@gjermundgaraba/effect-actions/Action"`. There is no package root.
- The `effect` peer is pinned to an exact release candidate (`4.0.0-rc.116`). Install the same version.
- Contracts are pure values. Nothing runs, binds, or acquires services until an adapter layer is built.

## Pages

| Read                                     | When you need to                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| [setup.md](setup.md)                     | install, pin versions, pick entry points, know what the package does not do            |
| [Action.md](Action.md)                   | define one contract: input, success, errors, read/write access, HTTP and MCP flags     |
| [ActionGroup.md](ActionGroup.md)         | group contracts, declare shared errors, bind handlers, map every contract by name      |
| [ActionHttp.md](ActionHttp.md)           | serve JSON POST routes, declare surface errors and one hook, publish OpenAPI, call it  |
| [ActionMcp.md](ActionMcp.md)             | serve MCP tools over Streamable HTTP or stdio                                          |
| [ActionToolkit.md](ActionToolkit.md)     | use actions as a native Effect AI `Toolkit` without a server                           |
| [ActionCli.md](ActionCli.md)             | run handlers in-process from a terminal command                                        |
| [ActionCliClient.md](ActionCliClient.md) | call the HTTP API from a terminal command                                              |
| [ActionCatalog.md](ActionCatalog.md)     | export contracts as an offline JSON document                                           |
| [Authentication.md](Authentication.md)   | provide a per-request identity, publish RFC 9728 discovery, build bearer challenges    |
| [Testing.md](Testing.md)                 | call routes in memory, build MCP requests, drive the official MCP client               |
| [guarantees.md](guarantees.md)           | cross-cutting rules: dependency lifetimes, wire formats, spans, request context, scope |

## Choose an adapter

- Callers speak JSON over HTTP: `ActionHttp`. Clients use Effect's `HttpApiClient` on `Http.api`.
- Callers are MCP clients: `ActionMcp.layerHttp` for a hosted endpoint, `ActionMcp.layerStdio` for a subprocess.
- Callers are an Effect AI program in the same process: `ActionToolkit`.
- Callers are humans or scripts in a terminal, handlers run locally: `ActionCli`.
- Callers are humans or scripts in a terminal, handlers run on a server: `ActionCliClient`.
- Nothing runs, only the contract is published: `ActionCatalog`.

One implementation (`group.implement(...)`) feeds every adapter.

## Minimal program

```ts
import { McpProtocol } from "effect/unstable/ai";
import { Effect, Layer, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  access: "read",
});

export const Actions = ActionGroup.make({ name: "greetings" }, Greet);

export const Http = ActionHttp.make({ apiPath: "/api/actions" }, Actions);

const app = Actions.implement({
  greet: ({ name }) => Effect.succeed(`Hello, ${name}!`),
});

export const routes = Layer.mergeAll(
  Http.layer({}, app),
  ActionMcp.layerHttp(
    { protocols: [McpProtocol.v2026_07_28], name: "greetings", version: "1.0.0", path: "/mcp" },
    app,
  ),
);
```

Serve `routes` with `HttpRouter.serve` and a platform server layer. Result: `POST /api/actions/greetings/greet` and an MCP tool `greet` at `/mcp`.

## Runnable examples

Repository directory `examples/` ([on GitHub](https://github.com/gjermundgaraba/effect-actions/tree/main/examples)):

- `quickstart.ts`, `quickstart-client.ts`: the minimal program and its typed client.
- `contracts.ts`, `handlers.ts`, `app.ts`, `server.ts`: an authenticated application with three groups, per-group middleware, two MCP endpoints, OpenAPI and Swagger.
- `toolkit.ts`, `catalog.ts`, `cli.ts`, `cli-client.ts`, `mcp-stdio.ts`: one file per other projection.
