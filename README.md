# @gjermundgaraba/effect-actions

Define an Effect action once, implement it once, expose it over **HTTP and MCP**.

**Experimental release candidate.** The repository currently uses Effect snapshot
[`4e4a3a6`](https://pkg.pr.new/Effect-TS/effect/effect@4e4a3a6). The MCP adapter
requires APIs missing from published `4.0.0-rc.115`, despite that being the current
peer declaration. Until these versions are aligned, use the pinned snapshot;
the declared peer version alone is not sufficient.

## Quickstart

```ts
import { Effect, Layer, Schema } from "effect";
import { Action, ActionGroup, ActionHttp, ActionMcp } from "@gjermundgaraba/effect-actions";

const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  mcp: { readOnly: true },
});

export const Actions = ActionGroup.make(Greet);
const app = Actions.implement({
  greet: ({ name }) => Effect.succeed(`Hello, ${name}!`),
});

export const routes = Layer.mergeAll(
  ActionHttp.layer(app, {
    apiPath: "/api/actions",
    openapiPath: "/openapi.json",
  }),
  ActionMcp.layer(app, { name: "greetings", version: "1.0.0", path: "/mcp" }),
);
```

Serve `routes` with Effect's `HttpRouter`. This creates `POST /api/actions/greet`,
`GET /openapi.json`, and an MCP endpoint at `/mcp`. The HTTP response is
`"Hello, Ada!"`; MCP returns `structuredContent: { value: "Hello, Ada!" }`.
See [examples/server.ts](examples/server.ts) for Node server wiring and the
[authenticated demo](examples/README.md) for a runnable application.

### Contracts

- `input` defaults to `Action.NoInput` for actions without arguments.
- `error` is a list of failure schemas, defaulting to none. Each schema retains
  its own `httpApiStatus` annotation.
- Actions default to both transports; use `http: false` or `mcp: false` to opt out.
- MCP input must have an object-root JSON Schema; declared errors must encode to
  objects. The MCP adapter checks this at Layer construction. HTTP allows scalars.
- `mcp.name` overrides the tool name. `destructive` defaults to `!readOnly`.
- Schemas must be service-free. Handlers may require services.

## HTTP client

Save the quickstart above as `quickstart.ts`. Once its routes are served:

```ts
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ActionHttp } from "@gjermundgaraba/effect-actions";
import { Actions } from "./quickstart.js";

export const greeting = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Actions, {
    apiPath: "/api/actions",
    baseUrl: "http://127.0.0.1:3000",
  });
  return yield* client.greet({ name: "Ada" });
}).pipe(Effect.provide(FetchHttpClient.layer));
```

Run `greeting` with `Effect.runPromise`. Methods take decoded inputs and return
decoded results; MCP-only actions are excluded. Authentication
headers can be added with `transformClient`. See [client details](docs/behavior.md#http-client-details)
for error types, optional inputs, and native grouped clients.

## Adapter options

| API                          | Options                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `ActionHttp.layer`           | `apiPath`, `openapiPath`, `schemaError`                                                 |
| `ActionHttp.api` / `openapi` | `apiPath`, `schemaError`                                                                |
| `ActionHttp.client`          | `apiPath`, `schemaError`, `baseUrl`, `transformClient`, `transformResponse`             |
| `ActionMcp.layer`            | `name`, `version`, `path`, `protocols`, `allowedOrigins`, `instructions`, `schemaError` |

`apiPath`, `openapiPath` (on `layer` / `configure`), and MCP `path` are required —
the library has no defaults. `ActionHttp.configure(options)` binds HTTP configuration
for its `layer`, `api`, `openapi`, and `client` methods. Configured clients accept
only connection options. Set `openapiPath: false` when the host serves a combined
document.

See [adapter behavior](docs/behavior.md) for shared schema-error policies,
dependency lifetimes, wire formats, and MCP protocol support.

## Scope

HTTP means JSON POST endpoints, not Effect's RPC wire protocol. Both adapters use
Effect's servers; there is no MCP SDK runtime dependency. Actions are unary:
no streaming, uploads, prompts, resources, or retries.

Authentication and authorization belong to the application. Tool discovery is
not filtered by actor. The example's bearer tokens are **demo-only**; production
needs real token validation, MCP authorization discovery, request limits, and
error reporting.

## Development and packaging

Requires a supported Node.js version (24 LTS recommended) and [Vite+](https://viteplus.dev).

```sh
vp install
vp check
vp test
vp run test:package
vp run example
```

`vp run dev` watches the library build. `vp check` also verifies the compile-time
assertions in `tests/types.ts`. Tests cover both transports, official MCP clients,
context isolation, schema-error policies, and cancellation.

`vp run build` emits ESM and declarations into `dist/`. Public entry points are the
package root, `/Action`, `/ActionGroup`, `/http`, `/mcp`, `/authentication`, `/testing`, and `/testing/client`.
`vp run test:package` builds and checks a tarball in an isolated consumer using the pinned
Effect snapshot; it does not establish compatibility with the published peer.

## Authentication and OAuth discovery

`Authentication.middleware(CurrentActor, { authenticate, errors, headers })` provides
an application-defined context service for each request. `authenticate` is an Effect;
`errors` lists its error schemas in precedence order. The first matching schema owns
both serialization and `httpApiStatus` (500 when unannotated). If its encoder fails,
the request fails as a server error; another schema is not tried. `headers(error)`
can add a Bearer challenge.
Responses use `Cache-Control: no-store`, including failures handled by enclosing middleware. Provide the returned middleware's `.layer` to
HTTP and MCP route layers. See [examples/app.ts](examples/app.ts).

Authentication dependencies are request requirements, as with native `HttpRouter.middleware`.
Use `.combine(...)` with middleware that provides them. Acquired resources stay alive
until the request scope closes. Downstream action errors are handled by their transport,
not serialized as authentication failures.

`ActionMcp.protectedResource({ resource, authorizationServers, scopesSupported })`
returns `{ layer, metadataUrl, challenge }`. Mount its public `layer` separately from
protected routes. It publishes [RFC 9728 metadata](https://www.rfc-editor.org/rfc/rfc9728.html)
at `/.well-known/oauth-protected-resource` followed by the resource path and query. Discovery
matches that literal path and query for GET and HEAD; other requests reach the host router.
Caching policy belongs to the host. `challenge()`
returns the `WWW-Authenticate` value; pass `{ error: "invalid_token" }` or
`{ error: "insufficient_scope", scope: "admin" }` where appropriate. Supported scopes
are advertised in metadata; the challenge names only scopes needed for that request.
The helper supports HTTPS URLs and loopback HTTP for development, with no credentials
or fragment. Resource identifiers may include a query; authorization-server issuers may not.
Your application owns login, consent, and token verification.

## MCP testing

Import `mcpRequest` from `@gjermundgaraba/effect-actions/testing`; it requires no MCP client dependency.
Import `withMcpClient` from `@gjermundgaraba/effect-actions/testing/client` and install
its optional peer `@modelcontextprotocol/client@^2.0.0`. Only the client entry point loads this peer.

- `mcpRequest(method, params?, { url, headers? })` builds a stateless 2026-07-28 request.
  `url` is required. Caller `params._meta` fields override the default client capabilities
  and information; application metadata is preserved. The protocol version stays pinned to
  2026-07-28 in both the request header and metadata. Metadata is merged shallowly.
- `withMcpClient(fetch, async client => ..., { path, mode?, baseUrl?, headers? })`
  connects the official client and closes it in a `finally` block. `path` is required.
  `mode` defaults to `"modern"` (2026-07-28); use `"legacy"` to exercise session negotiation.
