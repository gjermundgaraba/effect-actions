# effect-actions

Define an Effect action once. Serve it over HTTP and MCP, hand it to a model as a native
Toolkit, and run it from a CLI. Same schemas, same handler, Effect's own servers and clients
underneath.

## Looks like this

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

and a server that implements it, in a module of its own:

```ts
import { Effect, Layer } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Greet, Http } from "./quickstart.js";

// Every implementation states who may call it: here, anyone.
const greet = Action.implement(
  Greet,
  ({ name }) => Effect.succeed(`Hello, ${name}!`),
  Action.allowAll,
);

export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greet),
  ActionMcp.layerHttp(greet, { name: "greetings", version: "1.0.0" }),
);
```

Serve `routes` with Effect's `HttpRouter` and a platform server:

```ts
HttpRouter.serve(routes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 3000 })),
  Layer.launch,
  NodeRuntime.runMain,
);
```

and you have `POST /api/greet` and an MCP tool named `greet` at `/mcp`. The same `greet`
implementation is also:

```ts
const { toolkit, layer } = ActionToolkit.make(greet); // native Effect AI Toolkit and its handler layer
const cli = ActionCli.make(greet, { name: "greetings" }); // greetings greet --name Ada
const remote = ActionCli.command(Http, Greet); // greet --name Ada, over HTTP
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
- Action-level authorization is written once, on the implementation: `Action.implement(actions, handlers, before)`. Every surface that serves it runs the rule before each handler, so no surface can leave it out and no handler repeats the access policy. No implementation leaves it unsaid either: a public one states `Action.allowAll`. Record-level checks stay in handler data access. Authentication is native router middleware, provided around the HTTP and MCP layers like any other.
- Every action states whether it reads or writes (`access`), so that rule reads the contract instead of a hand-maintained list of mutation names.
- A handler or rule that needs a request identity requires that service in the surface's types. The host supplies it through authentication on protected requests. Types check that the identity is provided, not where from, so never provide one at startup. Public and authenticated routes share one binding, one mount path, one OpenAPI document and one client, and a handler's startup services are built once however many surfaces serve it.
- The pieces are Effect's own. `Http.api` is a native `HttpApi`, so OpenAPI, Swagger, Scalar and `HttpApiClient` work on it unchanged. MCP is Effect's native `McpServer`, with no SDK runtime dependency.
- Tests run in memory. `Action.client` calls an implementation in process, with the typed client's methods, behind its hook, as several callers in one test. Provide `Testing.layer(routes)`, then call the routes with the same typed client and the tools with `Testing.mcpClient`, without opening a port.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@4.0.0-rc.118
```

Add `@effect/platform-node@4.0.0-rc.118` to serve from Node. Every module is a subpath import
(`.../Action`, `.../ActionHttp`, ...); there is no package root, so a contracts-only bundle
never loads a server.

## Docs

The reference in [docs/](docs/README.md) is written for coding agents: one card per module
with the API, a canonical snippet, the rules, and the failure modes.

- [docs/README.md](docs/README.md): start here, includes which module to use for which caller.
- [docs/guarantees.md](docs/guarantees.md): cross-cutting rules for lifetimes, wire formats, and scope.
- [docs/CONTEXT.md](docs/CONTEXT.md): the vocabulary the docs and the code use.
- [examples/](examples/README.md): a runnable authenticated application with public and authenticated actions, two MCP endpoints, OpenAPI, and every other surface.

## For agents

```sh
npx skills add gjermundgaraba/effect-actions --skill effect-actions
```

The skill is generated from `docs/`, so pointing an agent at `docs/` (in this repository or
in `node_modules/@gjermundgaraba/effect-actions/docs`) gives the same content.

## Status

The `effect` peer accepts any Effect 4.0 release candidate from `4.0.0-rc.118` on; the package
is built and tested against the release candidate in its `devDependencies` (see [docs/setup.md](docs/setup.md)). Actions are unary JSON over HTTP and MCP: no streaming, uploads, prompts, or resources.
Token verification and the authorization rule belong to the application; the library supplies the authentication seam, the hook and the refusals. See [docs/setup.md](docs/setup.md).

## Acknowledgements

A few ideas (like the native Toolkit and CLI projections) are inspired by the excellent [rat-stack](https://github.com/joelhooks/rat-stack) by Joel Hooks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
