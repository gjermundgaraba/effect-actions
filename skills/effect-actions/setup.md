# Setup

Installation, version pins, entry points, a minimal program, and package boundaries.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@~4.0.0
```

| Need                                | Add                            |
| ----------------------------------- | ------------------------------ |
| Node HTTP server, stdio host or CLI | `@effect/platform-node@~4.0.0` |

Node `^22.12.0 || ^24.0.0 || >=26.0.0`. TypeScript 7 or newer; earlier versions are not
supported. ESM only.

## Entry points

There is no package root. Import one module per subpath, as a namespace:

```ts
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
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
  access: "read",
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

Serve `routes` with `HttpRouter.serve` and a platform server layer, with a request body limit ([guarantees.md](guarantees.md#wire-behavior)). Result: `POST /api/greet` and an MCP tool `greet` at `/mcp`.

## Browser

A browser app calls the server with `ActionHttp.client`, or `ActionHttp.fetchClient` outside an
Effect. It needs the contracts and the HTTP binding, and nothing else of the server. The package
declares `"sideEffects": false`, so a bundler may drop what a client does not use. Keep the
contracts and the binding in modules that import no server code, and import those alone from
the page, as the minimal program does:

```text
contracts.ts    Action.make(...) and ActionHttp.make([...]): imports effect only
handlers.ts     Action.implement(...): services, database, @effect/platform-node
server.ts       ActionHttp.layer, ActionMcp, Authentication
```

A module that calls `Action.implement` beside its contracts brings its handlers, and every
module they import, into the browser bundle: bundlers keep the call as written, even unused.
Split it. A page on another origin also needs CORS on the host, outside authentication: see
the browser example in [ActionMcp.md](ActionMcp.md#cross-origin-browsers).

`Action` and `ActionHttp`, and every module they import, import Effect through three
specifiers alone: `effect`, `effect/http` and `effect/http-api`. A page that loads Effect from
an import map rather than its bundle maps those three. A map pointing at Effect 4.0.0's
published files maps `effect/Cause`, `effect/Effect`, `effect/Exit` and `effect/Function` too,
to the same files the `effect` barrel loads, as Effect's own `Runtime` module imports them by
name; a build or CDN that resolves Effect's own imports needs only the three.
Serve each of the three whole. A page that re-exports only the names it uses, from a vendored
module or a trimmed bundle, fails at load with `does not provide an export named …` once the
package imports another name from the same specifier, as a release may: check such a list
against the package's imports on every upgrade.

Companion Effect modules you will import alongside: `effect/http-api` (`HttpApiClient`, `OpenApi`, `HttpApiSwagger`, `HttpApiScalar`), `effect/http` (`HttpRouter`, `HttpServerResponse`, `FetchHttpClient`, `HttpClientError`), `effect/cli` (`Command`, `Flag`, `Argument`).

## Rules

- Install a single `effect` version within the peer range, and keep every `@effect/*` package on that same release. Mixed versions can fail at the type level in ways that look like library bugs.
- Never import from `dist/` paths or from a package root. Only the subpaths above are public.
- Schemas passed to `Action.make` must be service-free (`Schema.Codec<_, _, never, never>`). Handlers may require services.

## Scope

What the package does and does not do: [guarantees.md](guarantees.md#scope).

## Failure modes

- `Cannot find module '@gjermundgaraba/effect-actions'`: there is no root export. Import a subpath.
- A browser build fails with `Could not resolve "node:…"`, or warns `Module "node:…" has been externalized for browser compatibility`: the page imports a module that also holds server code, such as a contract beside its `Action.implement`. Move the contracts and the binding to a module that imports no server code.
- A page that loads Effect from an import map still bundles a second copy of Effect, or of some of its modules: a module of the page imports an Effect specifier the map does not serve, such as `effect/Schema`. Serve `effect`, `effect/http` and `effect/http-api`, all `Action` and `ActionHttp` import, and import Effect through them in the page's own modules too.
- A page loading Effect from an import map fails before its modules run, with `Failed to resolve module specifier "effect/Cause"` in Chromium: the map points at Effect's published files and lacks a specifier Effect imports itself. Map `effect/Cause`, `effect/Effect`, `effect/Exit` and `effect/Function` to the same files, or serve Effect from a build that resolves its own imports.
- Type errors inside `effect/*` modules after install: `effect` version drift. Install one `effect` 4.0.x release for every package.
- An unmet peer warning for `effect@~4.0.0`, such as `found 4.1.0`: the installed Effect is a later minor than this release has been tested against. Install `effect` 4.0.x, with every `@effect/*` package on the same release, until a release of this package admits that minor.
- `Cannot find module 'effect/unstable/http'` (or `…/httpapi`, `…/cli`, `…/ai`): Effect `4.0.0-rc.118` moved these modules to `effect/http`, `effect/http-api`, `effect/cli` and `effect/ai`. Import the new paths.
- `Cannot find module 'effect/http'` (or `effect/http-api`, `effect/cli`, `effect/ai`), or at run time `Cannot find module '…/node_modules/effect/dist/http-api.js'` (or `http.js`, `ai.js`, `cli.js`): `effect` is a release candidate older than `4.0.0-rc.118`, which moved these modules out of `effect/unstable/*`. Install `effect` 4.0.0 or later.
