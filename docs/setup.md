# Setup

Install, version pins, entry points, and the boundaries of the package.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@4.0.0-rc.118
```

| Need                           | Add                                  |
| ------------------------------ | ------------------------------------ |
| Node HTTP server or stdio host | `@effect/platform-node@4.0.0-rc.118` |

Node `^22.12.0 || ^24.0.0 || >=26.0.0`. ESM only.

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
`Action` or `ActionHttp` never pulls in an MCP server or the AI toolkit; `test:package` bounds
what a client adds to a browser bundle.

## Browser

A browser app calls the server with `ActionHttp.client`. It needs the contracts and the HTTP
binding, and nothing else of the server. The package declares `"sideEffects": false`, so a
bundle of a client keeps `Action`, `ActionHttp.make` and `ActionHttp.client`, under 2 KB
gzipped beyond Effect's own `HttpApiClient` with Vite or esbuild, and drops every server
module. Keep the contracts and the binding in modules that import no server code, and import
those alone from the page, as the minimal program does:

```text
contracts.ts    Action.make(...) and ActionHttp.make([...]): imports effect only
handlers.ts     Action.implement(...): services, database, @effect/platform-node
server.ts       ActionHttp.layer, ActionMcp, Authentication
```

A module that calls `Action.implement` beside its contracts brings its handlers, and every
module they import, into the browser bundle: bundlers keep the call as written, even unused.
Split it. A page on another origin also needs CORS on the host, outside authentication: see
the browser example in [ActionMcp.md](ActionMcp.md#cross-origin-browsers).

Companion Effect modules you will import alongside: `effect/http-api` (`HttpApiClient`, `OpenApi`, `HttpApiSwagger`, `HttpApiScalar`), `effect/http` (`HttpRouter`, `HttpServerResponse`, `FetchHttpClient`, `HttpClientError`), `effect/cli` (`Command`, `Flag`, `Argument`).

## Rules

- Install a single `effect` version within the peer range, and keep every `@effect/*` package on that same release candidate. Mixed rc versions fail at the type level in ways that look like library bugs.
- Never import from `dist/` paths or from a package root. Only the subpaths above are public.
- Schemas passed to `Action.make` must be service-free (`Schema.Codec<_, _, never, never>`). Handlers may require services.

## Scope

What the package does and does not do: [guarantees.md](guarantees.md#scope).

## Failure modes

- `Cannot find module '@gjermundgaraba/effect-actions'`: there is no root export. Import a subpath.
- A browser build fails with `Could not resolve "node:…"`, or warns `Module "node:…" has been externalized for browser compatibility`: the page imports a module that also holds server code, such as a contract beside its `Action.implement`. Move the contracts and the binding to a module that imports no server code.
- Type errors inside `effect/*` modules after install: `effect` version drift. Install one `effect` release candidate within the peer range for every package.
- `Cannot find module 'effect/unstable/http'` (or `…/httpapi`, `…/cli`, `…/ai`): Effect `4.0.0-rc.118` moved these modules to `effect/http`, `effect/http-api`, `effect/cli` and `effect/ai`. Import the new paths.
