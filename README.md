# effect-actions

Define an Effect action once. Serve it over HTTP and MCP, hand it to a model as a native
Toolkit, run it from a CLI, and publish its contract as JSON. Same schemas, same handler,
Effect's own servers and clients underneath.

## Looks like this

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

Serve `routes` with Effect's `HttpRouter` and you have `POST /api/greet` and an MCP tool named
`greet` at `/mcp`. The same `greet` implementation is also:

```ts
const { toolkit, layer } = ActionToolkit.make(greet); // native Effect AI Toolkit and its handler layer
const cli = ActionCli.make(greet, { name: "greetings" }); // greetings greet --input '{"name":"Ada"}'
const remote = ActionCli.command(Http, Greet); // same command, over HTTP
const catalog = ActionCatalog.make([Greet]); // offline JSON contract, no handlers acquired
```

And the client is Effect's own `HttpApiClient`, typed from the same contract, one method per action:

```ts
const greeting = Effect.gen(function* () {
  const client = yield* ActionHttpClient.make(Http, { baseUrl });

  return yield* client.greet({ name: "Ada" });
});
```

Code that does not run Effects, such as a browser page, gets the same calls as Promises:
`await ActionHttpClient.promise(Http, { baseUrl }).greet({ name: "Ada" })`.

## Why

- Input, success, and errors are declared once. Routes, tools, commands, clients, OpenAPI, and the catalog are derived from that declaration, so they cannot disagree.
- A handler may fail only with the errors its action declares. One guard, `{ errors, before }`, binds to every surface as it is, and its hook runs before every handler the surface serves — after successful input decoding — so a policy such as scope enforcement is written once and no action can skip it.
- The pieces are Effect's own. `Http.api` is a native `HttpApi`, so `OpenApi.fromApi`, Swagger, Scalar, and `HttpApiClient` work on it unchanged. MCP is Effect's native `McpServer`, one `Tool` per action, with no SDK runtime dependency.
- Every action states its `access` (`"read"` or `"write"`, required), so authorization reads the contract instead of a hand-maintained list of mutation names.
- Build-time services and per-request services are tracked separately in the types. Middleware is per `ActionHttp.layer` call, so public and authenticated actions share one binding, one mount path, one document and one client, and each builder runs once however many surfaces serve it.
- Tests run in memory. Call the routes with the same typed client, and the tools with one call each, without opening a port.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@4.0.0-rc.117
```

Add `@effect/platform-node@4.0.0-rc.117` to serve from Node. Every module is a subpath import
(`.../Action`, `.../ActionHttp`, ...); there is no package root, so a contracts-only bundle
never loads a server.

## Docs

The reference in [docs/](docs/README.md) is written for coding agents: one card per module
with the API, a canonical snippet, the rules, and the failure modes.

- [docs/README.md](docs/README.md): start here, includes the adapter decision list.
- [docs/guarantees.md](docs/guarantees.md): cross-cutting rules for lifetimes, wire formats, and scope.
- [docs/CONTEXT.md](docs/CONTEXT.md): the vocabulary the docs and the code use.
- [examples/](examples/README.md): a runnable authenticated application with public and authenticated actions, two MCP endpoints, OpenAPI, and every other projection.

## For agents

```sh
npx skills add gjermundgaraba/effect-actions --skill effect-actions
```

The skill is generated from `docs/`, so pointing an agent at `docs/` (in this repository or
in `node_modules/@gjermundgaraba/effect-actions/docs`) gives the same content.

## Status

The `effect` peer accepts any Effect 4.0 release candidate from `4.0.0-rc.116` on; the package
is built and tested against the release candidate in its `devDependencies` (see [docs/setup.md](docs/setup.md)). Actions are unary JSON over HTTP and MCP: no streaming, uploads, prompts, or resources.
Authentication and authorization belong to the application. See [docs/setup.md](docs/setup.md).

## Acknowledgements

A few ideas (like the native Toolkit, CLI, and catalog projections) are inspired by the excellent [rat-stack](https://github.com/joelhooks/rat-stack) by Joel Hooks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
