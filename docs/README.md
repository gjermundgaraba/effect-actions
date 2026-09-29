# effect-actions reference

Reference for `@gjermundgaraba/effect-actions`, written for coding agents. Each public-module
card has the same sections: **API** (inventory and options), **Canonical** (the one right way to write
it), **Rules** (must and never), **Failure modes** (what you see when it is wrong, and the fix).
Routing, setup, vocabulary, and shared guarantees use the structure their role needs.
Read the card for a module before writing code that uses it. Exported TypeScript declarations are the exact signature reference. Vocabulary is defined in
[CONTEXT.md](CONTEXT.md); the pages use those terms exactly.

Package facts that apply everywhere:

- Every module is a subpath import: `import * as Action from "@gjermundgaraba/effect-actions/Action"`. There is no package root.
- The `effect` peer accepts any 4.0 release candidate from `4.0.0-rc.118` on (`>=4.0.0-rc.118 <4.0.0`). The package is built and tested against `4.0.0-rc.118`.
- Action contracts are pure values. Defining contracts and implementations runs neither handlers nor builder Effects. Builder services are acquired when a layer is built or a local CLI command runs; see [dependency lifetimes](guarantees.md#dependency-lifetimes).

## Pages

| Read                                   | When you need to                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [setup.md](setup.md)                   | install, run the minimal program, pick entry points, bundle a browser client, check package boundaries    |
| [Action.md](Action.md)                 | define a contract (input, success, errors, access, hints), bind its handler and hook, built-in errors     |
| [ActionHttp.md](ActionHttp.md)         | serve JSON POST routes, answer bad input, publish OpenAPI, call the API with one Effect method per action |
| [ActionMcp.md](ActionMcp.md)           | serve MCP tools over Streamable HTTP or stdio                                                             |
| [ActionToolkit.md](ActionToolkit.md)   | use actions as a native Effect AI `Toolkit` without a server                                              |
| [ActionCli.md](ActionCli.md)           | run handlers in-process, or call the HTTP API, from a command with derived flags                          |
| [Authentication.md](Authentication.md) | authenticate the callers of HTTP surfaces, refuse with 401/403, publish RFC 9728 discovery                |
| [Testing.md](Testing.md)               | call routes and tools in memory through `HttpClient`                                                      |
| [guarantees.md](guarantees.md)         | cross-cutting rules: builder lifetimes, wire formats, spans, request context, scope                       |

## Choose a surface

- Callers speak JSON over HTTP: `ActionHttp`. Clients use `ActionHttp.client(Http)`.
- Callers are MCP clients: `ActionMcp.layerHttp` for a hosted endpoint, `ActionMcp.runStdio` for a subprocess.
- Callers are an Effect AI program in the same process: `ActionToolkit`.
- Callers are humans or scripts in a terminal: `ActionCli`, from implementations to run handlers locally, or from the HTTP binding to call a server.

Every surface that runs handlers takes the same implementations (`Action.implement(...)`), one or a list, with options last. An implementation carries its own `before` hook, which every surface runs; surfaces take only their transport's options. Authentication is router middleware the host provides around the HTTP surfaces.

For first-time setup, follow the [minimal program](setup.md#minimal-program).

## Runnable examples

Repository directory `examples/`: the minimal program, an authenticated application served on
every surface, and one file per other surface, each listed in its
[README](https://github.com/gjermundgaraba/effect-actions/tree/main/examples#readme).
