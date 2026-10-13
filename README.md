# effect-actions

Define an Effect action once. Serve it over HTTP, MCP and Effect RPC, hand it to a model as a
native Toolkit, and run it from a CLI. Same schemas, same handler, Effect's own servers and clients
underneath.

**If you are a coding agent**, start at [docs/README.md](docs/README.md), not here, and read
one page per tool call, again alone if its output says it was truncated. It routes every task,
protecting an action and limiting request bodies included, to its page and its example.

## Looks like this

A contract says what an action takes and answers, and who may call it:

```ts example=quickstart/src/greeting/Greeting.ts
import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

// A contract: what the action takes and answers, whether it changes anything, and who may
// call it. It imports no server code, so any client can import it, a browser page included.
export const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: { name: Schema.String },
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});
```

An implementation binds it to its handler:

```ts example=quickstart/src/greeting/handlers.ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Greet } from "./Greeting.js";

// The implementation: the contract bound to its handler. Every surface takes this one value.
export const greeting = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));
```

A binding gives it a route, for the server to serve and a client to call:

```ts example=quickstart/src/Api.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Greet } from "./greeting/Greeting.js";

// The HTTP binding: `POST /api/greet`. The server serves it and the client calls it.
export const Http = ActionHttp.make([Greet]);
```

And the same implementation is served on every surface the host wants:

```ts example=quickstart/src/routes.ts
import { Layer } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Http } from "./Api.js";
import { greeting } from "./greeting/handlers.js";

// One implementation, two surfaces: a JSON route and an MCP tool at `/mcp`.
export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greeting),
  ActionMcp.layerHttp(greeting, { name: "greetings", version: "1.0.0" }),
);
```

Serve `routes` with Effect's `HttpRouter.serve` and a platform server, as
[examples/quickstart/src/server.ts](examples/quickstart/src/server.ts) does, and you have
`POST /api/greet` and an MCP tool named `greet` at `/mcp`. The same `greeting`
implementation is also:

```ts
const { toolkit, layer } = ActionToolkit.make(greeting); // native Effect AI Toolkit and its handler layer
const cli = ActionCli.make(greeting, { name: "greetings" }); // greetings greet --name Ada
const remote = ActionCli.remoteCommand(Http, Greet, { client: { baseUrl } }); // greet --name Ada, over HTTP
const local = Action.client(greeting); // the HTTP client's methods, in process
const rpc = ActionRpc.layer(ActionRpc.make([Greet]), greeting); // Effect RPC, on the protocol the host provides
```

And the client is Effect's own `HttpApiClient`, typed from the same contract, one method per action:

```ts
const greeting = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, { baseUrl });

  return yield* client.greet({ name: "Ada" });
});
```

## Why

- Input, success and errors are declared once. Routes, tools, CLI flags, clients and the OpenAPI document are derived from that declaration, so they cannot disagree.
- A handler can fail only with the errors its action declares and three built-in ones (400, 401, 403), and every client decodes them as typed values.
- Every contract states who may call it: `caller: Action.Anyone`, or the identity service a caller must have. A surface authenticates a protected action's request before decoding its input, with the provider the application builds from its own token verifier.
- Authorization is written once, on the implementation: `Action.implement(actions, handlers, { authorize })`, required for protected actions. Every surface runs it before each handler, and the rule reads the contract's `readOnly` instead of a hand-maintained list of mutation names.
- Public and protected routes share one binding, one OpenAPI document and one client, and a handler's startup services are built once per [layer graph](docs/Action.md#implement-actions), however many surfaces serve it.
- The pieces are Effect's own: a native `HttpApi`, `McpServer`, `RpcServer` and `RpcClient`, with no SDK runtime dependency, so OpenAPI, Swagger, Scalar and `HttpApiClient` work unchanged.
- Tests run in memory: `Action.client` calls an implementation in process, and `Testing.layer(routes)` serves the routes and tools to typed clients without opening a port.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@~4.0.4
```

It needs TypeScript 7 or newer and is ESM only
([docs/setup.md](docs/setup.md#install)). Add `@effect/platform-node@~4.0.4` to serve or run a CLI from Node. Every module is a
subpath import (`.../Action`, `.../ActionHttp`, ...); there is no package root, so a
contracts-only bundle never loads a server.

## Examples

[examples/](examples/README.md) holds complete applications, each a directory you can run, with
its own tests, laid out the way we recommend for an application: a folder per domain, the
contract in one file a browser can import, one entrypoint per way of running it. They are
type-checked and tested with the library and ship in the package.

- [quickstart](examples/quickstart/): the program above.
- [notes-service](examples/notes-service/): a service with bearer authentication, a JSON API
  and MCP tools from one implementation, a CLI and a browser client. Most applications are this.
- [mcp-tools](examples/mcp-tools/): an MCP server whose tools wrap an upstream HTTP API.
- [assistant](examples/assistant/): no server, the same implementations as a model's tools
  and as local commands.
- [live-rpc](examples/live-rpc/): Effect RPC over a WebSocket.
- [kitchen-sink](examples/kitchen-sink/): every module and nearly every option in one
  application, with an index from each to the file that shows it.

## Docs

[docs/](docs/README.md) is written for coding agents: one short page per module, organized by
task, each linking to the example files that show the task working.

- [docs/README.md](docs/README.md): start here: which page answers which task, and which
  surface to use for which caller.
- [docs/guarantees.md](docs/guarantees.md): what each case looks like on the wire, on every
  surface, and what the library leaves to the application.
- [docs/CONTEXT.md](docs/CONTEXT.md): the vocabulary the docs and the code use.

## For agents

The `effect-actions` skill puts the docs in front of a coding agent. With the
[skills CLI](https://github.com/vercel-labs/skills), for any agent it supports:

```sh
npx skills add gjermundgaraba/effect-actions --skill effect-actions
```

As a Claude Code plugin:

```text
/plugin marketplace add gjermundgaraba/effect-actions
/plugin install effect-actions@effect-actions-marketplace
```

As a Codex plugin:

```sh
codex plugin marketplace add gjermundgaraba/effect-actions
codex plugin add effect-actions@effect-actions-marketplace
```

The skill is generated from `docs/` on the main branch, which can be ahead of the latest
release. Its links to the examples are paths into the installed package,
`node_modules/@gjermundgaraba/effect-actions/examples`, which an agent reads without a network;
the pages of the installed version are beside them, in
`node_modules/@gjermundgaraba/effect-actions/docs`.

## Status

The `effect` peer admits the patches of the Effect release the package is tested against, since
the modules the surfaces build on may change in a minor release (see [docs/setup.md](docs/setup.md#install)). Actions are unary JSON over HTTP, MCP and Effect RPC, whose protocols speak JSON alone: no streaming or uploads.
Token verification and the authorization rule belong to the application; the library supplies the authentication descriptor and provider, runs the rule, and answers the refusals. See [docs/guarantees.md](docs/guarantees.md#scope).

## Acknowledgements

A few ideas (like the native Toolkit and CLI projections) are inspired by the excellent [rat-stack](https://github.com/joelhooks/rat-stack) by Joel Hooks.

## Contributing

The rules for changing the library are in
[AGENTS.md](https://github.com/gjermundgaraba/effect-actions/blob/main/AGENTS.md). MIT licensed.
