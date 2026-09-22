# effect-actions

Define an Effect action once. Serve it over HTTP and MCP, hand it to a model as a native
Toolkit, run it from a CLI, and publish its contract as JSON. Same schemas, same handler,
Effect's own servers and clients underneath.

## Looks like this

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
  Http.layer([app]),
  ActionMcp.layerHttp([app], {
    protocols: [McpProtocol.v2026_07_28],
    name: "greetings",
    version: "1.0.0",
    path: "/mcp",
  }),
);
```

Serve `routes` with Effect's `HttpRouter` and you have `POST /api/actions/greetings/greet`
and an MCP tool named `greet` at `/mcp`. The same `app` is also:

```ts
const { toolkit, layer } = ActionToolkit.make([app]); // native Effect AI Toolkit and its handler layer
const cli = ActionCli.group(app); // greetings greet --input '{"name":"Ada"}'
const remote = ActionCliClient.command(Http, "greetings", "greet"); // same command, over HTTP
const catalog = ActionCatalog.make(Actions); // offline JSON contract, no handlers acquired
```

And the client is Effect's own, typed from the same contract:

```ts
const greeting = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Http.api, { baseUrl });

  return yield* client.greetings.greet({ payload: { name: "Ada" } });
});
```

## Why

- Input, success, and errors are declared once. Routes, tools, commands, clients, OpenAPI, and the catalog are derived from that declaration, so they cannot disagree.
- A handler may fail only with the errors its action declares. Each surface binds one `before` hook that runs before every handler it serves — after successful input decoding — so a policy such as scope enforcement is written once per surface and no action of that surface can skip it.
- The pieces are Effect's own. `Http.api` is a native `HttpApi`, so `OpenApi.fromApi`, Swagger, Scalar, and `HttpApiClient` work on it unchanged. MCP is Effect's native `McpServer`, one `Tool` per action, with no SDK runtime dependency.
- Every action states its `access` (`"read"` or `"write"`, required), so authorization reads the contract instead of a hand-maintained list of mutation names.
- Build-time services and per-request services are tracked separately in the types. Middleware is per group, so a public group and an authenticated group can share one mount path.
- Tests run in memory. Call the routes through a web handler with the same typed client, or drive the official MCP client, without opening a port.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@4.0.0-rc.116
```

Add `@effect/platform-node@4.0.0-rc.116` to serve from Node. Every module is a subpath import
(`.../Action`, `.../ActionHttp`, ...); there is no package root, so a contracts-only bundle
never loads a server.

## Docs

The reference in [docs/](docs/README.md) is written for coding agents: one card per module
with the API, a canonical snippet, the rules, and the failure modes.

- [docs/README.md](docs/README.md): start here, includes the adapter decision list.
- [docs/guarantees.md](docs/guarantees.md): cross-cutting rules for lifetimes, wire formats, and scope.
- [docs/CONTEXT.md](docs/CONTEXT.md): the vocabulary the docs and the code use.
- [examples/](examples/README.md): a runnable authenticated application with three groups, two MCP endpoints, OpenAPI, and every other projection.

## For agents

```sh
npx skills add gjermundgaraba/effect-actions --skill effect-actions
```

The skill is generated from `docs/`, so pointing an agent at `docs/` (in this repository or
in `node_modules/@gjermundgaraba/effect-actions/docs`) gives the same content.

## Status

The `effect` peer is pinned to an exact Effect 4 release candidate and moves with it; expect a
release of this package for each Effect release candidate it adopts. Actions are unary JSON over HTTP and MCP: no streaming, uploads, prompts, or resources.
Authentication and authorization belong to the application. See [docs/setup.md](docs/setup.md).

## Acknowledgements

A few ideas (like the native Toolkit, CLI, and catalog projections) are inspired by the excellent [rat-stack](https://github.com/joelhooks/rat-stack) by Joel Hooks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
