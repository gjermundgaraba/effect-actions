# Setup

Install, version pins, entry points, and the boundaries of the package.

## Install

```sh
pnpm add @gjermundgaraba/effect-actions@rc effect@4.0.0-rc.116
```

| Need                           | Add                                                   |
| ------------------------------ | ----------------------------------------------------- |
| Node HTTP server or stdio host | `@effect/platform-node@4.0.0-rc.116`                  |
| `TestingClient.withMcpClient`  | `@modelcontextprotocol/client@^2.0.0` (optional peer) |

Node `^22.12.0 || ^24.0.0 || >=26.0.0`. ESM only.

## Entry points

There is no package root. Import one module per subpath, as a namespace:

```ts
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import * as ActionCatalog from "@gjermundgaraba/effect-actions/ActionCatalog";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionCliClient from "@gjermundgaraba/effect-actions/ActionCliClient";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import * as TestingClient from "@gjermundgaraba/effect-actions/TestingClient";
```

Every module imports from the `effect` package only, with two exceptions worth knowing when
bundling: `ActionMcp` and `ActionToolkit` are the only modules that import `effect/unstable/ai`,
and `TestingClient` is the only module that imports the optional `@modelcontextprotocol/client`
peer. Because there is no package root, importing a contract module never pulls in an MCP
server or the peer.

Companion Effect modules you will import alongside: `effect/unstable/httpapi` (`HttpApiClient`, `OpenApi`, `HttpApiSwagger`, `HttpApiScalar`), `effect/unstable/http` (`HttpRouter`, `HttpServerResponse`, `FetchHttpClient`), `effect/unstable/ai` (`McpProtocol`), `effect/unstable/cli` (`Command`, `Flag`, `Argument`).

## Rules

- Pin `effect` to the exact release candidate the package declares as peer. Mixed rc versions fail at the type level in ways that look like library bugs.
- Never import from `dist/` paths or from a package root. Only the subpaths above are public.
- Schemas passed to `Action.make` must be service-free (`Schema.Codec<_, _, never, never>`). Handlers may require services.

## Scope

What the package does, and nothing else:

- HTTP means JSON `POST` endpoints built on Effect's `HttpApi`. It is not Effect RPC.
- MCP means one native `McpServer` `Tool` per action. There is no MCP SDK runtime dependency.
- Actions are unary: one decoded input, one decoded success or one declared error. No streaming, uploads, prompts, resources, retries, or code-execution sandbox.
- Authentication and authorization are the application's. The library provides a middleware shape and discovery metadata, not a token verifier. Tool discovery is never filtered by actor.

## Failure modes

- `Cannot find module '@gjermundgaraba/effect-actions'`: there is no root export. Import a subpath.
- Type errors inside `effect/unstable/*` after install: `effect` version drift. Align to the peer pin.
- `@modelcontextprotocol/client` resolution errors in a server build: something imported `TestingClient`. Only tests should.
