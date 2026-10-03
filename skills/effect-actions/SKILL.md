---
name: effect-actions
description: >
  Use when implementing, integrating, or testing @gjermundgaraba/effect-actions,
  which defines Effect action contracts once for HTTP, MCP, native Toolkits, and CLIs.
  These pages follow the repository's main branch, which can be ahead of the latest
  release; where the package is installed, read the same pages in
  node_modules/@gjermundgaraba/effect-actions/docs/, which describe the installed version.
---

# effect-actions reference

Reference for `@gjermundgaraba/effect-actions`, written for coding agents. Each public-module
card has the same sections: **API** (inventory and options), **Canonical** (the one right way to write
it), **Rules** (must and never), **Failure modes** (what you see when it is wrong, and the fix).
Routing, setup, vocabulary, and shared guarantees use the structure their role needs.
Read the card for a module before writing code that uses it. Exported TypeScript declarations are the exact signature reference. Vocabulary is defined in
[CONTEXT.md](CONTEXT.md); the pages use those terms exactly.

Package facts that apply everywhere:

- Every module is a subpath import: `import * as Action from "@gjermundgaraba/effect-actions/Action"`. There is no package root.
- The `effect` peer is `~4.0.0`: Effect's 4.0.x patches. Effect marks the HTTP, HTTP API, AI and CLI modules the surfaces build on unstable, so a minor release may change them; a later minor is admitted once the package is tested against it. The package is built and tested against `4.0.0`.
- Action contracts are pure values. Defining contracts and implementations runs neither handlers nor builder Effects. Builder services are acquired when a layer is built, an `Action.client` is acquired, or a local CLI command runs; see [dependency lifetimes](guarantees.md#dependency-lifetimes).

## Pages

| Read                                   | When you need to                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [setup.md](setup.md)                   | install, run the minimal program, pick entry points, bundle a browser client, check package boundaries                         |
| [Action.md](Action.md)                 | define a contract, bind its handler and hook, use built-in errors, call or test implementations in process (`Action.client`)   |
| [ActionHttp.md](ActionHttp.md)         | serve JSON POST routes, answer bad input, publish OpenAPI, call the API with one Effect method per action                      |
| [ActionMcp.md](ActionMcp.md)           | serve MCP tools over Streamable HTTP or stdio                                                                                  |
| [ActionToolkit.md](ActionToolkit.md)   | use actions as a native Effect AI `Toolkit` without a server                                                                   |
| [ActionCli.md](ActionCli.md)           | run handlers in-process, or call the HTTP API, from a command with derived flags                                               |
| [Authentication.md](Authentication.md) | authenticate HTTP surfaces' callers, refuse with 401/403, publish RFC 9728 discovery, let signed-out callers share one MCP URL |
| [Testing.md](Testing.md)               | call routes and tools in memory through `HttpClient`, or test an implementation in process                                     |
| [guarantees.md](guarantees.md)         | rules every surface shares: builder lifetimes, authorization, wire formats, names, spans, the package's scope                  |
| [CONTEXT.md](CONTEXT.md)               | look up a term the pages use                                                                                                   |

## Choose a surface

- Callers speak JSON over HTTP: `ActionHttp`. Clients use `ActionHttp.client(Http)`.
- Callers are MCP clients: `ActionMcp.layerHttp` for a hosted endpoint, `ActionMcp.runStdio` for a subprocess.
- Callers are an Effect AI program in the same process: `ActionToolkit`.
- Callers are humans or scripts in a terminal: `ActionCli`, from implementations to run handlers locally, or from the HTTP binding to call a server.
- Callers are your own code in the same process, such as a test, a job or a command of your own: `Action.client`, with the methods of `ActionHttp.client`.

Every surface that runs handlers takes the same implementations (`Action.implement(...)`), one or a list, with options last. An implementation carries its own `before` hook, which every surface runs, `Action.allowAll` where no action-level rule applies; surfaces take only their transport's options. Authentication is router middleware the host provides around the HTTP surfaces.

For first-time setup, follow the [minimal program](setup.md#minimal-program).

## Runnable examples

Repository directory `examples/`: the minimal program, an authenticated application served on
every surface, and one file per other surface, each listed in its
[README](https://github.com/gjermundgaraba/effect-actions/tree/main/examples#readme).
