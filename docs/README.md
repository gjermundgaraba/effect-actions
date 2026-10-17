# effect-actions

`@gjermundgaraba/effect-actions` defines an Effect action once, as a contract with one
implementation, and serves it over HTTP, MCP and Effect RPC, gives it to a model as a native
Toolkit, and runs it from a CLI. Every surface is Effect's own server or client, running the
same schemas, handler and authorization.

## How to read these pages

**Arriving with an error?** Search the `*-failures.md` pages for a fragment of its message
first (step 5), before the examples and the pages.

1. **Open one page per tool call, with your file-reading tool.** Pages are kept small to reduce
   truncation. Several in one call, however many commands it runs, can be cut by its output
   limit, with no mark or with one that understates what is lost. If an output says it was
   truncated, read that page again alone.
2. **Start from the example closest to what you are building** ([Examples](#examples)). Its
   README has a layout tree, and all but quickstart's a "Where to look" table naming the file
   for each thing. Copy its layout and idioms: the examples are the reference for how code is
   written. An example shows one way, not the rules, the alternatives or the traps: read steps
   3 and 4 even when it fits.
3. **Read [Action.md](Action.md) completely.** Every surface builds on it.
4. **Read the page of each surface you serve** ([Pages](#pages)), and the example files its task
   sections link.
5. **When something fails, search the `*-failures.md` pages** for a fragment of the message
   without quotes, your own code's first compile error included, before reasoning it out:
   `grep -rnF "<fragment>" node_modules/@gjermundgaraba/effect-actions/docs/*-failures.md`. Each
   module page has one beside it, such as [Action-failures.md](Action-failures.md).

A service others call is [notes-service](../examples/notes-service/) plus
[Action.md](Action.md), [ActionHttp.md](ActionHttp.md), [ActionMcp.md](ActionMcp.md),
[Authentication.md](Authentication.md) and [Testing.md](Testing.md).

Where things are, in a project that installs the package: these pages in
`node_modules/@gjermundgaraba/effect-actions/docs/`, the examples in `examples/` beside them, and
the declarations with their JSDoc, the reference for signatures, in `dist/<Module>.d.mts`, all at
the installed version. Install first ([setup.md](setup.md#install)): it needs TypeScript 7 and
one Effect release. Every module is a subpath import, `@gjermundgaraba/effect-actions/Action`;
there is no package root.

## Pages

| Read                                                     | When you need to                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [setup.md](setup.md)                                     | install, write `tsconfig.json`, import the modules, write the minimal program, lay out an application, bundle a browser client              |
| [Action.md](Action.md)                                   | define a contract and who may call it, implement it, authorize calls, fail with declared and built-in errors                                |
| [Action-in-process.md](Action-in-process.md)             | call actions from your own code, such as a job; share one build of the implementations across servers and jobs                              |
| [ActionHttp.md](ActionHttp.md)                           | bind actions to JSON routes, serve them, limit request bodies, publish OpenAPI, call them from Effect or a browser                          |
| [ActionMcp.md](ActionMcp.md)                             | serve MCP tools over HTTP or stdio, describe them to a model, return images, protect them, allow browser clients, add prompts and resources |
| [ActionRpc.md](ActionRpc.md)                             | bind actions to Effect rpcs, serve them on a protocol, call them, send request context with a call                                          |
| [ActionToolkit.md](ActionToolkit.md)                     | give a model actions as a native Effect AI `Toolkit`, name the caller, ask for approval                                                     |
| [ActionCli.md](ActionCli.md)                             | run actions as local commands, or call a server from commands; shape flags, input and output; add a command of your own                     |
| [Authentication.md](Authentication.md)                   | declare how callers sign in, verify credentials, publish OAuth discovery, step up for a scope                                               |
| [Authentication-advanced.md](Authentication-advanced.md) | use an API key or a cookie, read the request in a verifier, protect a route of your own, run a request policy before authentication         |
| [Testing.md](Testing.md)                                 | test an implementation in process, and routes, tools and rpcs in memory, as a signed-in caller; assert on errors                            |
| [guarantees.md](guarantees.md)                           | see the status and body of one case, such as bad input, a declared error or a refusal, on each surface; what the library leaves to you      |
| [CONTEXT.md](CONTEXT.md)                                 | look up a term the pages use                                                                                                                |

## Examples

| Example                                     | What it is                                                                                                       | Start from it when                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [quickstart](../examples/quickstart/)       | One action, served as a JSON route and an MCP tool, called with its typed client.                                | You want the smallest thing that runs.                                  |
| [notes-service](../examples/notes-service/) | A service with bearer authentication: a JSON API and MCP tools from one implementation, a CLI, a browser client. | You are building a service others call. Most applications are this.     |
| [mcp-tools](../examples/mcp-tools/)         | An MCP server whose tools wrap an upstream HTTP API, over stdio and over HTTP, with an image result.             | You are putting an existing API in front of a model.                    |
| [assistant](../examples/assistant/)         | No server: the same implementations as a model's tools, with approval of writes, and as local commands.          | A model calls your code in process, or you are building a local CLI.    |
| [live-rpc](../examples/live-rpc/)           | Effect RPC over a WebSocket with a browser-shaped client, each message carrying its own token.                   | A client keeps a connection open, or the application speaks Effect RPC. |
| [kitchen-sink](../examples/kitchen-sink/)   | The reference: a multi-tenant issue tracker using every module and nearly every option, with an index.           | You need a working use of one specific feature.                         |

Each example's README says where to look for what. The index in
[kitchen-sink](../examples/kitchen-sink/README.md#index) maps every export and option it uses to
a file. Every token, user and store in the examples is a demo, marked `DEMO ONLY` where it must
change before a deployment.

## Choose a surface

| Callers                                                        | Use                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Speak JSON over HTTP                                           | `ActionHttp`; clients use `ActionHttp.client`, or `ActionHttp.fetchClient` outside an Effect                       |
| Are Effect programs, such as a page over one WebSocket         | `ActionRpc`; clients use `ActionRpc.client`                                                                        |
| Are MCP clients                                                | `ActionMcp.layerHttp` for a hosted endpoint, `ActionMcp.runStdio` for a subprocess, which runs the handlers itself |
| Are a model in the same process                                | `ActionToolkit`                                                                                                    |
| Are people or scripts in a terminal                            | `ActionCli`: `make` runs handlers locally, `remote` calls a server through its HTTP binding                        |
| Are your own code in the same process, such as a job or a test | `Action.client`                                                                                                    |

Surfaces combine: every one that runs handlers takes the same implementations, one or a list,
and enforces each contract's `caller` and its implementation's `authorize`
([Action.md](Action.md#authorize-calls)).
