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
against, and no later minor: Effect marks the HTTP, HTTP API, AI and CLI modules the surfaces build
on unstable, so a minor release may change them. A release of this package admits a later minor
once it is tested against it.

Node `^22.12.0 || ^24.0.0 || >=26.0.0`. TypeScript 7 or newer; earlier versions are not
supported. ESM only.

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

Every module imports from the `effect` package only. There is no package root, so importing
`Action` or `ActionHttp` never pulls in an MCP server or the AI toolkit.

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

Serve `routes` with `HttpRouter.serve` and a platform server layer, with a request body limit ([guarantees.md](guarantees.md#wire-behavior)). Result: `POST /api/greet` and an MCP tool `greet` at `/mcp`. Anything else the process runs, such as a job or an agent, goes inside the layer `HttpRouter.serve` serves, not merged beside it: beside it, the builders and your own services it shares with the routes may run twice, each with state of its own, and nothing reports it ([dependency lifetimes](guarantees.md#dependency-lifetimes)).

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

A module that calls `Action.implement` beside its contracts brings its handlers, and every
module they import, into the browser bundle: bundlers keep the call as written, even unused.
Split it. A page on another origin also needs CORS on the host, outside authentication: see
the browser example in [ActionMcp.md](ActionMcp.md#cross-origin-browsers).

`Action`, `ActionHttp` and `Authentication`, and every module they import, import Effect through three
specifiers alone: `effect`, `effect/http` and `effect/http-api`; `ActionRpc` adds `effect/rpc`. A
page that loads Effect from an import map rather than its bundle maps those three, and
`effect/rpc` with `ActionRpc`, and `effect/socket` too for its WebSocket client. A map pointing at Effect's
published files maps `effect/Cause`, `effect/Effect`, `effect/Exit` and `effect/Function` too,
to the same files the `effect` barrel loads, as Effect's own `Runtime` module imports them by
name; a build or CDN that resolves Effect's own imports needs only those specifiers.
Serve each of them whole. A page that re-exports only the names it uses, from a vendored
module or a trimmed bundle, fails at load with `does not provide an export named …` once the
package imports another name from the same specifier, as a release may: check such a list
against the package's imports on every upgrade.

Companion Effect modules you will import alongside: `effect/http-api` (`HttpApiClient`, `OpenApi`, `HttpApiSwagger`, `HttpApiScalar`), `effect/http` (`HttpRouter`, `HttpServerResponse`, `FetchHttpClient`, `HttpClientError`), `effect/rpc` (`RpcServer`, `RpcClient`, `RpcSerialization`, `RpcMiddleware`), `effect/cli` (`Command`, `Flag`, `Argument`).

## Rules

- Install a single `effect` version within the peer range, and keep every `@effect/*` package on that same release. Mixed versions can fail at the type level in ways that look like library bugs.
- Never import from `dist/` paths or from a package root. Only the subpaths above are public.
- Schemas passed to `Action.make` must be service-free (`Schema.Codec<_, _, never, never>`). Handlers may require services.

## Scope

What the package does and does not do: [guarantees.md](guarantees.md#scope).

## Failure modes

- `Cannot find module '@gjermundgaraba/effect-actions'`: there is no root export. Import a subpath.
- A browser build fails with `Could not resolve "node:…"`, or warns `Module "node:…" has been externalized for browser compatibility`: the page imports a module that also holds server code, such as a contract beside its `Action.implement`, or an authentication descriptor beside its `Authentication.layer` verifier. Move the contracts, their identities, the descriptor and the binding to modules that import no server code.
- A page that loads Effect from an import map still bundles a second copy of Effect, or of some of its modules: a module of the page imports an Effect specifier the map does not serve, such as `effect/Schema`. Serve `effect`, `effect/http` and `effect/http-api`, all `Action`, `ActionHttp` and `Authentication` import, `effect/rpc` too with `ActionRpc`, and `effect/socket` with its WebSocket client, and import Effect through them in the page's own modules too.
- A page loading Effect from an import map fails before its modules run, with `Failed to resolve module specifier "effect/Cause"` in Chromium: the map points at Effect's published files and lacks a specifier Effect imports itself. Map `effect/Cause`, `effect/Effect`, `effect/Exit` and `effect/Function` to the same files, or serve Effect from a build that resolves its own imports.
- Type errors inside `effect/*` modules after install: `effect` version drift. Install one `effect` release, in the peer range, for every package.
- An unmet peer warning for `effect`, such as `found 4.1.0`: the installed Effect is outside the releases this one is tested against. Install the `effect` range [Install](#install) names, with every `@effect/*` package on the same release.
- `Cannot find module 'effect/unstable/http'` (or `…/httpapi`, `…/cli`, `…/ai`): Effect `4.0.0-rc.118` moved these modules to `effect/http`, `effect/http-api`, `effect/cli` and `effect/ai`. Import the new paths.
- `Cannot find module 'effect/http'` (or `effect/http-api`, `effect/cli`, `effect/ai`), or at run time `Cannot find module '…/node_modules/effect/dist/http-api.js'` (or `http.js`, `ai.js`, `cli.js`): `effect` is a release candidate older than `4.0.0-rc.118`, which moved these modules out of `effect/unstable/*`. Install the `effect` range [Install](#install) names.
