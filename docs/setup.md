# Setup

Install, version pins, entry points, and the boundaries of the package.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions effect@4.0.0-rc.117
```

| Need                           | Add                                  |
| ------------------------------ | ------------------------------------ |
| Node HTTP server or stdio host | `@effect/platform-node@4.0.0-rc.117` |

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

Every module imports from the `effect` package only. `ActionMcp` and `ActionToolkit` are the
only modules that import `effect/unstable/ai`; because there is no package root, importing a
contract module never pulls in an MCP server.

Companion Effect modules you will import alongside: `effect/unstable/httpapi` (`HttpApiClient`, `OpenApi`, `HttpApiSwagger`, `HttpApiScalar`), `effect/unstable/http` (`HttpRouter`, `HttpServerResponse`, `FetchHttpClient`, `HttpClientError`), `effect/unstable/cli` (`Command`, `Flag`, `Argument`).

## Rules

- Install a single `effect` version within the peer range, and keep every `@effect/*` package on that same release candidate. Mixed rc versions fail at the type level in ways that look like library bugs.
- Never import from `dist/` paths or from a package root. Only the subpaths above are public.
- Schemas passed to `Action.make` must be service-free (`Schema.Codec<_, _, never, never>`). Handlers may require services.

## Scope

What the package does and does not do: [guarantees.md](guarantees.md#scope).

## Failure modes

- `Cannot find module '@gjermundgaraba/effect-actions'`: there is no root export. Import a subpath.
- Type errors inside `effect/unstable/*` after install: `effect` version drift. Install one `effect` release candidate within the peer range for every package.
