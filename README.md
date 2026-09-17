# @gjermundgaraba/effect-actions

Define an Effect action once, implement it once, expose it over **HTTP and MCP**.

**Experimental release candidate.** The repository currently uses Effect snapshot
[`4e4a3a6`](https://pkg.pr.new/Effect-TS/effect/effect@4e4a3a6). The MCP adapter
requires APIs missing from published `4.0.0-rc.115`, despite that being the current
peer declaration. Until these versions are aligned, use the pinned snapshot;
the declared peer version alone is not sufficient.

```sh
pnpm add @gjermundgaraba/effect-actions \
  effect@https://pkg.pr.new/Effect-TS/effect/effect@4e4a3a6
```

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

export const Actions = ActionGroup.make("greetings", Greet);

export const Http = ActionHttp.make(Actions, { apiPath: "/api/actions" });

const app = Actions.implement({
  greet: ({ name }) => Effect.succeed(`Hello, ${name}!`),
});

export const routes = Layer.mergeAll(
  Http.layer(app, { openapiPath: "/openapi.json" }),
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
- `errors` is a list of failure schemas, defaulting to none. Each schema retains
  its own `httpApiStatus` annotation.
- Actions default to both transports; use `http: false` or `mcp: false` to opt out.
  An action exposed on neither is rejected.
- MCP input must have an object-root JSON Schema; declared errors must encode to
  objects. The MCP adapter checks this at Layer construction. HTTP allows scalars.
- `mcp.name` overrides the tool name. `destructive` defaults to `!readOnly`.
- Schemas must be service-free. Handlers may require services.
- The group name is the OpenAPI tag and operation-ID prefix (`greetings.greet`).

## HTTP client

Save the quickstart above as `quickstart.ts`. Once its routes are served:

```ts
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Http } from "./quickstart.js";

export const greeting = Effect.gen(function* () {
  const client = yield* Http.client({ baseUrl: "http://127.0.0.1:3000" });

  return yield* client.greet({ name: "Ada" });
}).pipe(Effect.provide(FetchHttpClient.layer));
```

Run `greeting` with `Effect.runPromise`. Methods take decoded inputs and return
decoded results; MCP-only actions are excluded. `ActionHttp.make` binds what the
server and its clients must agree on (`apiPath` and the schema-error policy), so
`client` accepts only connection options. Authentication headers can be added with
`transformClient`. See [client details](docs/behavior.md#http-client-details)
for error types, optional inputs, and native grouped clients.

## Multiple groups

Both adapters accept one group or several, so an application can split its
contracts and handlers without splitting its endpoints:

```ts
const Http = ActionHttp.make([Users, Billing], { apiPath: "/api/actions" });

const routes = Layer.mergeAll(
  Http.layer([UsersApp, BillingApp], { openapiPath: "/openapi.json" }),
  ActionMcp.layer([UsersApp, BillingApp], { name: "my-app", version: "1.0.0", path: "/mcp" }),
);
```

Each adapter reads only what it serves: the HTTP-enabled actions for `ActionHttp`, the
tools for `ActionMcp`. Everything else follows from that view.

- **Pairing.** `Http.layer(apps, options)` needs exactly one implementation for every group
  with an HTTP action, in any order, matched by identity. An implementation of a group that
  was not given to `make` does not compile; a missing one throws when the layer is constructed.
- **Acquisition.** A group the adapter does not serve needs no implementation there, and
  one that is passed anyway is not built. Requirement types are the union over what is
  passed, so leaving it out also leaves out its requirements.
- **Names.** Routes and client methods are flat (`POST /api/actions/<action>`,
  `client.<action>()`), so group names and HTTP action names must be unique within
  one `ActionHttp.make`, and tool names within one `ActionMcp.layer`. Duplicates throw at
  construction; neither adapter looks at the other's names.
- **Lists.** Both adapters accept ordinary arrays, so one `apps` list can be shared or
  assembled with `map` and `filter`.

### Groups under their own middleware

Router middleware applies to the layer that registers the routes. `Http.group(app)` is the
route layer of one group, so each can have its own. `Http.groups(options)` serves the
document and requires the `group` layer of every group with an HTTP action:

```ts
const routes = Http.groups({ openapiPath: "/openapi.json" }).pipe(
  Layer.provide(Http.group(PublicApp)),
  Layer.provide(Http.group(UserApp).pipe(Layer.provide(authentication.layer))),
);
```

A group that is never mounted leaves `ActionHttp.Mounted<"/api/actions", "users">`
unsatisfied where the layer is run, which does not compile, as with any missing Layer. The
requirement names the routes themselves, so a group layer of an adapter mounted elsewhere,
or one built from a union of implementations, does not satisfy it; one from another adapter
at the same path fails when the layer is built. Provide the groups rather than merging
them. Middleware provided to `groups` before the group layers guards only the document;
provided after them, it guards everything. See [examples/app.ts](examples/app.ts).

An MCP endpoint is one route, so middleware provided to `ActionMcp.layer`, authentication
included, covers all of its tools. Handlers can still authorize each tool differently on one
endpoint. Only tools that need different middleware, such as none at all, need their own
endpoint: one `ActionMcp.layer` per `path`, each with its own registry.

## Adapter options

| API                          | Options                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `ActionHttp.make(groups, …)` | `apiPath`, `schemaError`                                                                |
| `Http.layer(apps, …)`        | `openapiPath`                                                                           |
| `Http.groups(…)`             | `openapiPath`                                                                           |
| `Http.group(app)`            | None                                                                                    |
| `Http.client(…)`             | `baseUrl`, `transformClient`, `transformResponse`                                       |
| `ActionMcp.layer(apps, …)`   | `name`, `version`, `path`, `protocols`, `allowedOrigins`, `instructions`, `schemaError` |

`apiPath`, `openapiPath`, and MCP `path` are required: the library has no defaults.
Set `openapiPath: false` when the host serves a combined document. `Http.api` is the
native `HttpApi`, built once and shared by the routes, the clients, and `Http.openapi()`.

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
assertions in `tests/types.spec.ts`. Tests cover both transports, official MCP clients,
context isolation, schema-error policies, and cancellation.

`vp run build` emits ESM and declarations into `dist/`. Public entry points are the
package root and one subpath per module: `/Action`, `/ActionGroup`, `/ActionHttp`, `/ActionMcp`,
`/Authentication`, `/Testing`, and `/TestingClient`.
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

`Authentication.protectedResource({ resource, authorizationServers, scopesSupported })`
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

```ts
const discovery = Authentication.protectedResource({
  resource: "https://api.example.com/mcp",
  authorizationServers: ["https://auth.example.com"],
});

const authentication = Authentication.middleware(CurrentActor, {
  authenticate,
  errors: [Unauthenticated],
  headers: () => ({ "www-authenticate": discovery.challenge({ error: "invalid_token" }) }),
});

const routes = Layer.mergeAll(
  discovery.layer,
  protectedRoutes.pipe(Layer.provide(authentication.layer)),
);
```

## Testing

Import from `@gjermundgaraba/effect-actions/Testing`; it requires no MCP client dependency.
`withMcpClient` lives in `@gjermundgaraba/effect-actions/TestingClient` and needs the optional
peer `@modelcontextprotocol/client@^2.0.0`. Only that entry point loads the peer.

```ts
const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)));

const greeting = Effect.gen(function* () {
  const client = yield* httpClient(Http, web.handler);

  return yield* client.greet({ name: "Ada" });
});
```

- `httpClient(Http, handler, options?)` is the typed HTTP client calling a web handler in
  memory. `options` are the client's connection options; `baseUrl` defaults to `http://localhost`.
- `mcpRequest({ url, method, params?, headers? })` builds a stateless 2026-07-28 request.
  Caller `params._meta` fields override the default client capabilities
  and information; application metadata is preserved. The protocol version stays pinned to
  2026-07-28 in both the request header and metadata. Metadata is merged shallowly.
- `withMcpClient({ fetch, path, mode?, baseUrl?, headers? }, async client => ...)`
  connects the official client and closes it in a `finally` block.
  `mode` defaults to `"modern"` (2026-07-28); use `"legacy"` to exercise session negotiation.
