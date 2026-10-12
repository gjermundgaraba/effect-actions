---
name: effect-actions
description: >
  Use when implementing, integrating, or testing @gjermundgaraba/effect-actions,
  which defines Effect action contracts once for HTTP, MCP, Effect RPC, native Toolkits, and CLIs.
  These pages follow the repository's main branch, which can be ahead of the latest
  release; where the package is installed, read the same pages in
  node_modules/@gjermundgaraba/effect-actions/docs/, which describe the installed version.
---

# effect-actions reference

Reference for `@gjermundgaraba/effect-actions`, written for coding agents. Each public-module
card has the same sections: **API** (inventory and options), **Canonical** (the one right way to write
it), **Rules** (must and never), **Failure modes** (what you see when it is wrong, and the fix).
Read the card for a module before writing code that uses it. Exported TypeScript declarations are the exact signature reference. Vocabulary is defined in
[CONTEXT.md](CONTEXT.md); the pages use those terms exactly.

Package facts that apply everywhere:

- Every module is a subpath import: `import * as Action from "@gjermundgaraba/effect-actions/Action"`. There is no package root.
- The `effect` peer admits only the patches of one Effect release ([setup.md](setup.md#install)).

## Pages

| Read                                   | When you need to                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [setup.md](setup.md)                   | install, run the minimal program, pick entry points, bundle a browser client, check package boundaries                                                    |
| [Action.md](Action.md)                 | define a contract and who may call it, bind its handler and authorization, use built-in errors, call or test implementations in process (`Action.client`) |
| [ActionHttp.md](ActionHttp.md)         | serve JSON POST routes, answer bad input, publish OpenAPI, call the API with one Effect method per action                                                 |
| [ActionMcp.md](ActionMcp.md)           | serve MCP tools over Streamable HTTP or stdio                                                                                                             |
| [ActionRpc.md](ActionRpc.md)           | serve actions as Effect RPC over any protocol speaking JSON, call them with one Effect method per action                                                  |
| [ActionToolkit.md](ActionToolkit.md)   | use actions as a native Effect AI `Toolkit` without a server                                                                                              |
| [ActionCli.md](ActionCli.md)           | run handlers in-process, or call the HTTP API, from a command with derived flags                                                                          |
| [Authentication.md](Authentication.md) | declare how a remote caller proves its identity, verify it on HTTP, MCP and RPC surfaces, refuse with 401/403, publish RFC 9728 discovery                 |
| [Testing.md](Testing.md)               | call routes, tools and rpcs in memory through `HttpClient`, or test an implementation in process                                                          |
| [guarantees.md](guarantees.md)         | rules every surface shares: builder lifetimes, authorization, wire formats, names, spans, the package's scope                                             |
| [CONTEXT.md](CONTEXT.md)               | look up a term the pages use                                                                                                                              |

## Choose a surface

- Callers speak JSON over HTTP: `ActionHttp`. Clients use `ActionHttp.client(Http)`.
- Callers are Effect programs speaking Effect RPC, such as a page over one WebSocket: `ActionRpc`. Clients use `ActionRpc.client(Rpc)`.
- Callers are MCP clients: `ActionMcp.layerHttp` for a hosted endpoint, `ActionMcp.runStdio` for a subprocess.
- Callers are an Effect AI program in the same process: `ActionToolkit`.
- Callers are humans or scripts in a terminal: `ActionCli`, `make` and `command` from implementations to run handlers locally, or `remote` and `remoteCommand` from the HTTP binding to call a server.
- Callers are your own code in the same process, such as a test, a job or a command of your own: `Action.client`, with the methods of `ActionHttp.client`.

Every surface that runs handlers takes the same implementations (`Action.implement(...)`), one or a list, with options last, and enforces each contract's `caller` and its implementation's `authorize` ([guarantees.md](guarantees.md#authorization)).

## Runnable examples

Repository directory `examples/`: runnable programs, each listed in its
[README](https://github.com/gjermundgaraba/effect-actions/tree/main/examples#readme).
