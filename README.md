# effect-actions

Define an Effect action once. Serve it over HTTP and MCP, hand it to a model as a native
Toolkit, and run it from a CLI. Same schemas, same handler, Effect's own servers and clients
underneath.

## Looks like this

```ts example=quickstart.ts
import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

// The contract and its HTTP binding import no server code, so any client can import them,
// a browser page included.
export const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: { name: Schema.String },
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});

export const Http = ActionHttp.make([Greet]);
```

and a server that implements it, in a module of its own:

```ts example=quickstart-server.ts
import { Effect, Layer } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Greet, Http } from "./quickstart.js";

// The contract states who may call it, here anyone, so its implementation takes no `authorize`.
const greet = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));

export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greet),
  ActionMcp.layerHttp(greet, { name: "greetings", version: "1.0.0" }),
);
```

Serve `routes` with Effect's `HttpRouter.serve` and a platform server, with a request body
limit, as [examples/server.ts](examples/server.ts) serves the example application, and you
have `POST /api/greet` and an MCP tool named `greet` at `/mcp`. The same `greet`
implementation is also:

```ts
const { toolkit, layer } = ActionToolkit.make(greet); // native Effect AI Toolkit and its handler layer
const cli = ActionCli.make(greet, { name: "greetings" }); // greetings greet --name Ada
const remote = ActionCli.remoteCommand(Http, Greet, { client: { baseUrl } }); // greet --name Ada, over HTTP
const local = Action.client(greet); // the HTTP client's methods, in process
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
- A handler can fail only with the errors its action declares and three built-in ones, and every client decodes them as typed values. Bad input, a missing credential and a refusal come back as those built-in errors (400, 401, 403), never as an unreadable body.
- Every contract states who may call it: `caller: Action.Anyone`, or the identity service a caller must have. A surface serving a protected action authenticates it before decoding its input, through the authentication descriptor its binding names, and the provider the application builds from its own token verifier.
- Action-level authorization is written once, on the implementation: `Action.implement(actions, handlers, { authorize })`, required for protected actions. Every surface that serves it runs the rule before each handler, so no surface can leave it out and no handler repeats the access policy; `Action.allowAll` admits every authenticated caller. Operational limits, such as a rate limit, and record-level checks stay in the handler, failing with errors the contract lists.
- Every action states whether it is read-only (`readOnly`), so that rule reads the contract instead of a hand-maintained list of mutation names.
- A protected action's handler and rule read the identity its contract names, which only authentication of that request supplies; a startup identity never opens a protected route. Public and protected routes share one binding, one mount path, one OpenAPI document, which states the credentials each needs, and one client, and a handler's startup services are built once per [layer graph](docs/guarantees.md#dependency-lifetimes), however many surfaces serve it.
- The pieces are Effect's own. `Http.api` is a native `HttpApi`, so OpenAPI, Swagger, Scalar and `HttpApiClient` work on it unchanged. MCP is Effect's native `McpServer`, with no SDK runtime dependency.
- Tests run in memory. `Action.client` calls an implementation in process, with the typed client's methods, behind its `authorize`, as several callers in one test. Provide `Testing.layer(routes)`, then call the routes with the same typed client and the tools with `Testing.mcpClient`, without opening a port.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@~4.0.0
```

Add `@effect/platform-node@~4.0.0` to serve or run a CLI from Node. Every module is a
subpath import (`.../Action`, `.../ActionHttp`, ...); there is no package root, so a
contracts-only bundle never loads a server.

## Docs

The reference in [docs/](docs/README.md) is written for coding agents: one card per module
with the API, a canonical snippet, the rules, and the failure modes.

- [docs/README.md](docs/README.md): start here, includes which module to use for which caller.
- [docs/guarantees.md](docs/guarantees.md): cross-cutting rules for lifetimes, wire formats, and scope.
- [docs/CONTEXT.md](docs/CONTEXT.md): the vocabulary the docs and the code use.
- [examples/](examples/README.md): a runnable authenticated application with public and authenticated actions, an MCP endpoint, OpenAPI, and every other surface.

## For agents

```sh
npx skills add gjermundgaraba/effect-actions --skill effect-actions
```

The skill is generated from `docs/` on the main branch, which can be ahead of the latest
release; in a project that installs the package, point the agent at
`node_modules/@gjermundgaraba/effect-actions/docs`, the pages of the installed version.

## Status

The `effect` peer is `~4.0.0`, Effect's 4.0.x patches, since the modules the surfaces build on may
change in a minor release; the package is built and tested against the Effect release in its
`devDependencies` (see [docs/setup.md](docs/setup.md)). Actions are unary JSON over HTTP and MCP: no streaming, uploads, prompts, or resources.
Token verification and the authorization rule belong to the application; the library supplies the authentication descriptor and provider, runs the rule, and answers the refusals. See [docs/setup.md](docs/setup.md).

## Acknowledgements

A few ideas (like the native Toolkit and CLI projections) are inspired by the excellent [rat-stack](https://github.com/joelhooks/rat-stack) by Joel Hooks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
