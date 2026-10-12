# Setup

Installation, version pins, entry points, a minimal program, and package boundaries.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@~4.0.2
```

| Need                                | Add                            |
| ----------------------------------- | ------------------------------ |
| Node HTTP server, stdio host or CLI | `@effect/platform-node@~4.0.2` |

The `effect` peer admits the patches of the Effect release the package is built and tested
against, and no later minor: Effect marks the HTTP, HTTP API, RPC, AI and CLI modules the surfaces
build on unstable, so a minor release may change them. A release of this package admits a later
minor once it is tested against it.

Node `^22.12.0 || ^24.0.0 || >=26.0.0`. TypeScript 7 or newer. ESM only.

## Entry points

There is no package root. Import one module per subpath, as a namespace:

```ts
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
```

Every module imports from the `effect` package only. Importing `Action` or `ActionHttp` never
pulls in an MCP server or the AI toolkit.

## Minimal program

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

The server, in its own module, so that a browser client imports the contract alone:

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

Serve `routes` with `HttpRouter.serve` and a platform server layer, with a request body limit ([guarantees.md](guarantees.md#wire-behavior)). Result: `POST /api/greet` and an MCP tool `greet` at `/mcp`. Anything else the process runs, such as a job or an agent, goes inside the layer `HttpRouter.serve` serves, not merged beside it ([dependency lifetimes](guarantees.md#dependency-lifetimes)).

## Browser

A browser app calls the server with `ActionHttp.client`, or `ActionHttp.fetchClient` outside an
Effect, or over Effect RPC with `ActionRpc.client`. It needs the contracts, their identities, the
binding and its authentication descriptor, and nothing else of the server. The package
declares `"sideEffects": false`, so a bundler may drop what a client does not use. Keep the
contracts and the binding in modules that import no server code, and import those alone from
the page, as the minimal program does:

```text
identity.ts     Context.Service declarations a protected contract names: imports effect only
contracts.ts    Action.make(...), Authentication.make(...), ActionHttp.make([...]), ActionRpc.make([...])
handlers.ts     Action.implement(...): services, database, @effect/platform-node
server.ts       ActionHttp.layer, ActionRpc.layer, ActionMcp, Authentication.layer and its verifier
```

A page on another origin also needs CORS on the host, outside authentication: see the browser
example in [ActionMcp.md](ActionMcp.md#cross-origin-browsers).

`Action`, `ActionHttp` and `Authentication`, and every module they import, import Effect through three
specifiers alone: `effect`, `effect/http` and `effect/http-api`; `ActionRpc` adds `effect/rpc`.

Companion Effect modules you will import alongside: `effect/http-api` (`HttpApiClient`, `OpenApi`, `HttpApiSwagger`, `HttpApiScalar`), `effect/http` (`HttpRouter`, `HttpServerResponse`, `FetchHttpClient`, `HttpClientError`), `effect/rpc` (`RpcServer`, `RpcClient`, `RpcSerialization`, `RpcMiddleware`), `effect/cli` (`Command`, `Flag`, `Argument`).

## Rules

- Never import from `dist/` paths or from a package root. Only the subpaths above are public.

## Failure modes

- `Cannot find module '@gjermundgaraba/effect-actions'`: there is no root export. Import a subpath.
- A browser build fails with `Could not resolve "node:…"`, or warns `Module "node:…" has been externalized for browser compatibility`: the page imports a module that also holds server code, such as a contract beside its `Action.implement`, which bundlers keep as written, even unused, or an authentication descriptor beside its `Authentication.layer` verifier. Move the contracts, their identities, the descriptor and the binding to modules that import no server code.
- A page that loads Effect from an import map still bundles a second copy of Effect, or of some of its modules: a module of the page imports an Effect specifier the map does not serve, such as `effect/Schema`. Serve `effect`, `effect/http` and `effect/http-api`, all `Action`, `ActionHttp` and `Authentication` import, `effect/rpc` too with `ActionRpc`, and `effect/socket` with its WebSocket client, and import Effect through them in the page's own modules too.
- A page loading Effect from an import map fails before its modules run, with `Failed to resolve module specifier "effect/Cause"` in Chromium: the map points at Effect's published files and lacks a specifier Effect imports itself. Map `effect/Cause`, `effect/Effect`, `effect/Exit` and `effect/Function` to the same files, or serve Effect from a build that resolves its own imports.
- A page fails at load with `does not provide an export named …`: it re-exports only the names it uses of an Effect specifier, from a vendored module or a trimmed bundle, and the package imports another name from it, as a release may. Serve each specifier whole, or check such a list against the package's imports on every upgrade.
- Type errors inside `effect/*` modules after install: `effect` version drift. Install one `effect` release, in the peer range, for every package.
- An unmet peer warning for `effect`, such as `found 4.1.0`: the installed Effect is outside the releases this one is tested against. Install the `effect` range [Install](#install) names, with every `@effect/*` package on the same release.
- `Cannot find module 'effect/unstable/http'` (or `…/httpapi`, `…/cli`, `…/ai`): these modules moved to `effect/http`, `effect/http-api`, `effect/cli` and `effect/ai`. Import the new paths.
