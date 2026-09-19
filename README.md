# @gjermundgaraba/effect-actions

Define an Effect action once, implement it once, and expose it through **HTTP, MCP, native Effect Toolkits, and CLIs**. Export an offline JSON catalog from the same contracts.

**Snapshot-dependent preview.** This release requires Effect snapshot
[`9ad9891`](https://pkg.pr.new/Effect-TS/effect/effect@9ad9891). The published npm
version `effect@4.0.0-rc.115` is not compatible: it lacks APIs required by the MCP
adapter. Install both packages explicitly:

```sh
pnpm add @gjermundgaraba/effect-actions@rc \
  'effect@https://pkg.pr.new/Effect-TS/effect/effect@9ad9891'
```

The snapshot reports version `4.0.0-rc.115`, so the package retains that nominal
peer declaration. A semver peer cannot distinguish the snapshot from the npm
build; satisfying the peer declaration alone does **not** ensure compatibility.
Installation requires access to `pkg.pr.new`, not just the npm registry.

For Node server wiring, use the matching platform snapshot too:

```sh
pnpm add '@effect/platform-node@https://pkg.pr.new/Effect-TS/effect/@effect/platform-node@9ad9891'
```

## Quickstart

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
  mcp: { readOnly: true },
});

export const Actions = ActionGroup.make({ name: "greetings" }, Greet);

export const Http = ActionHttp.make({ apiPath: "/api/actions" }, Actions);

const app = Actions.implement({
  greet: ({ name }) => Effect.succeed(`Hello, ${name}!`),
});

export const routes = Layer.mergeAll(
  Http.layer(app),
  ActionMcp.layerHttp(
    { protocols: [McpProtocol.v2026_07_28], name: "greetings", version: "1.0.0", path: "/mcp" },
    app,
  ),
);
```

Serve `routes` with Effect's `HttpRouter`. This creates `POST /api/actions/greetings/greet` and an
MCP endpoint at `/mcp`. The HTTP response is `"Hello, Ada!"`; MCP returns
`structuredContent: { value: "Hello, Ada!" }`; a declared error is an `isError` result
whose text is the same JSON encoding HTTP sends as the body.
See [examples/server.ts](examples/server.ts) for Node server wiring and the
[authenticated demo](examples/README.md) for a runnable application.

### Contracts

- Omit `input` for an action without arguments.
- `errors` is a list of failure schemas, defaulting to none. Each schema retains
  its own `httpApiStatus` annotation.
- A group's `errors` are added to every one of its actions, so a shared set, such as
  authorization failures, is declared once. Its `schemaError` policy decides how HTTP
  answers failed decoding or encoding; MCP keeps the native toolkit's answers. See
  [schema-error policies](docs/behavior.md#schema-error-policies).
- Actions default to both transports; use `http: false` or `mcp: false` to opt out.
  Actions disabled on both remain available for explicitly mounted local CLI commands.
- Action and group names match `[A-Za-z0-9_-]+` and are not `then`, which
  would make a client thenable.
- MCP input must have an object-root JSON Schema; the MCP adapter checks this at Layer
  construction. HTTP allows scalar input. Results and errors may be any shape: MCP wraps
  results as `{ value }` and reports errors as text, the protocol's own error channel.
- `mcp.name` overrides the tool name (at most 128 characters). Tool hints default to
  `readOnly: false`, `destructive: !readOnly`, `idempotent: false`, and `openWorld: true`.
  Hints do not enforce authorization, approval, or retries.
- Schemas must be service-free. Handlers may require services.
- The group name is the OpenAPI tag and operation-ID prefix (`greetings.greet`).

## HTTP client

Save the quickstart above as `quickstart.ts`. Once its routes are served:

```ts
import { HttpApiClient } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Http } from "./quickstart.js";

export const greeting = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Http.api, { baseUrl: "http://127.0.0.1:3000" });

  return yield* client.greetings.greet({ payload: { name: "Ada" } });
}).pipe(Effect.provide(FetchHttpClient.layer));
```

Run `greeting` with `Effect.runPromise`. Use Effect's native `HttpApiClient.make(Http.api,
options)`: methods are grouped by action group and take explicit `{ payload: ... }`
arguments, including `{ payload: {} }` for no-input actions. Inputs and results are
decoded values; MCP-only actions are excluded. HTTP paths include the group: `<apiPath>/<group>/<action>`.
Authentication headers can be added with `transformClient`. See
[client details](docs/behavior.md#http-client-details) for error types and response modes.

## Multiple groups

An application can split its contracts and handlers into groups without splitting its
endpoints. Configuration comes first, then the groups or implementations:

```ts
import { McpProtocol } from "effect/unstable/ai";

const Http = ActionHttp.make({ apiPath: "/api/actions" }, PublicActions, UserActions);

const routes = Layer.mergeAll(
  Http.layer(PublicApp),
  Http.layer(UserApp).pipe(Layer.provide(authentication.layer)),
  ActionMcp.layerHttp(
    { protocols: [McpProtocol.v2026_07_28], name: "my-app", version: "1.0.0", path: "/mcp" },
    UserApp,
    AuditApp,
  ),
);
```

- **Explicit mounting.** `Http.layer(...apps)` registers the routes of the supplied groups, and router
  middleware provided to a layer applies to that layer alone: above, only the user group
  requires authentication. Use separate calls when groups need different middleware. A group that is never mounted has no routes.
- **Each adapter reads only what it serves.** A group without HTTP actions registers nothing
  and is not built by `Http.layer`, nor one without tools by `ActionMcp.layerHttp`.
- **Names.** Routes are `POST /api/actions/<group>/<action>`, and native client methods
  are `client.<group>.<action>({ payload: ... })`. Group names must be unique within
  `ActionHttp.make`; action names need only be unique within their group. Tool names
  must be unique within each Toolkit or MCP projection. Adapters validate the
  namespaces they serve, not another transport's names.
- **MCP middleware is per endpoint.** An MCP endpoint is one route, so middleware provided
  to `ActionMcp.layerHttp`, authentication included, covers all of its tools. Handlers can still
  authorize each tool differently. Only tools that need different middleware, such as none
  at all, need their own endpoint: one `ActionMcp.layerHttp` per `path`.

Each group is its own native `HttpApiGroup`, so a host can also combine separately made
`Http.api` values with `HttpApi.addHttpApi`. See [examples/app.ts](examples/app.ts).

## Serving the document

`Http.api` is a native `HttpApi`, carrying every route, description, declared error and
policy error. Documents and documentation UIs are therefore Effect's own:

```ts
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiScalar, HttpApiSwagger, OpenApi } from "effect/unstable/httpapi";

const documentation = Layer.mergeAll(
  HttpRouter.add("GET", "/openapi.json", HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api))),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
  HttpApiScalar.layer(Http.api, { path: "/reference" }),
);
```

Each is an ordinary route layer, so it takes whatever middleware it is provided. The same
value gives Effect's grouped client: `HttpApiClient.make(Http.api)`.

## More projections

The same implementation can be used without an HTTP server:

```ts
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import * as ActionCatalog from "@gjermundgaraba/effect-actions/ActionCatalog";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionCliClient from "@gjermundgaraba/effect-actions/ActionCliClient";
import { Argument } from "effect/unstable/cli";

// Using Actions, Http, and app from the quickstart:
const tools = ActionToolkit.make(app); // { toolkit, layer }, native Effect Toolkit
const catalog = ActionCatalog.make(Actions); // JSON-serializable; no handlers acquired
const command = ActionCli.group(app); // greetings greet --input '{"name":"Ada"}'
const local = ActionCli.command(app, "greet", {
  parameters: { name: Argument.String("name") },
  input: ({ name }) => ({ name }),
}); // greet Ada
const remote = ActionCliClient.command(Http, "greetings", "greet"); // host supplies HttpClient
```

- **Toolkit:** MCP-enabled actions become native tools with their declared names and
  hints. Calls retain invocation-service requirements and return native results, not
  MCP envelopes. See [examples/toolkit.ts](examples/toolkit.ts).
- **MCP stdio:** `ActionMcp.layerStdio({ name, version, protocols }, ...apps)` runs a
  subprocess server using a host-provided `Stdio` service and trusted process principal.
  See [examples/mcp-stdio.ts](examples/mcp-stdio.ts). Stdout is protocol-only.
- **Catalog:** standalone input/output/error JSON schemas with local `$defs`, plus
  metadata and group-qualified identities. See [examples/catalog.ts](examples/catalog.ts).
- **Local CLI:** `.command(app, "actionName", options?)` selects one action; `.group(app,
options?)` selects a group, including local-only actions. The host supplies services.
- **Remote CLI:** `ActionCliClient` projects HTTP contracts into commands using native
  `HttpApiClient`; it never executes local handlers or manages credentials. See
  [examples/cli.ts](examples/cli.ts) and [examples/cli-client.ts](examples/cli-client.ts).

Generated CLI commands accept whole-input `--input '<json>'`. For a human-oriented
command, supply native Effect flags/arguments through `parameters` and map them to
encoded action input with `input`. Explicitly configured commands do not also accept
`--input`; their syntax is independent of schema changes. Commands print validated
JSON by default; an optional renderer enables human output with `--json` available.
See [CLI boundaries](docs/behavior.md#cli-boundaries) for codecs and configuration.

## Adapter options

| API                                    | Options                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `ActionGroup.make(options, …actions)`  | `name`, `errors`, `schemaError`                                          |
| `ActionHttp.make(options, …groups)`    | `apiPath`                                                                |
| `Http.layer(...apps)`                  | None                                                                     |
| `ActionMcp.layerHttp(options, …apps)`  | `name`, `version`, `path`, `protocols`, `allowedOrigins`, `instructions` |
| `ActionMcp.layerStdio(options, …apps)` | `name`, `version`, `protocols`, `instructions`                           |

`apiPath` and MCP `path` have no defaults. `Http` has two members: `api` and `layer`. MCP `protocols` is required and takes Effect’s native `McpProtocol` adapters.
Effect owns protocol negotiation and sessions.

See [adapter behavior](docs/behavior.md) for shared schema-error policies,
dependency lifetimes, wire formats, and MCP protocol support.

## Scope

HTTP means JSON POST endpoints, not Effect's RPC wire protocol. HTTP and MCP use
Effect's servers: `HttpApi` and one `McpServer` `Tool` per action; there is no MCP SDK
runtime dependency. Actions are unary:
no streaming, uploads, prompts, resources, retries, or code-execution sandbox.

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
request-context handling, schema-error policies, and cancellation.

`vp run build` emits module-preserving ESM and declarations into `dist/`. The entry points
are one subpath per module: `/Action`, `/ActionGroup`, `/ActionHttp`, `/ActionMcp`,
`/ActionToolkit`, `/ActionCatalog`, `/ActionCli`, `/ActionCliClient`, `/Authentication`,
`/Testing`, and `/TestingClient`. There is no package root, so a contracts-only or browser bundle never
loads the MCP server or the optional client peer.
`vp run test:package` builds and checks a tarball in an isolated consumer with
`skipLibCheck: false`, using the pinned Effect snapshot; it does not establish compatibility
with the published peer.

## Authentication and OAuth discovery

`Authentication.middleware(CurrentActor, authenticate)` provides an application-defined
context service for each request. `authenticate` is an Effect that succeeds with the
identity or fails with the `HttpServerResponse` to send instead, so the host owns the
status, body and any Bearer challenge: `HttpServerResponse.schemaJson(Unauthenticated)(error,
{ status: 401, headers })`. Responses use `Cache-Control: no-store`, including failures handled
by enclosing middleware. Provide the returned middleware's `.layer` to HTTP and MCP route
layers. See [examples/app.ts](examples/app.ts).

Use distinct service tags for startup capabilities and request identities. Never supply
`CurrentActor` or other request-identity tags through startup layers or root context:
native Effect context capture can shadow request values or supply missing runtime values.
The adapters do not provide an additional context-isolation boundary.

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
`{ error: "insufficient_scope", scope: "admin" }` where appropriate. Parameter values are
quoted and escaped, never rejected. Supported scopes are advertised in metadata; the
challenge names only scopes needed for that request. The helper publishes what it is given:
your deployment is responsible for these being valid OAuth URLs (HTTPS, or loopback HTTP in
development), and your application owns login, consent, and token verification.

```ts
const discovery = Authentication.protectedResource({
  resource: "https://api.example.com/mcp",
  authorizationServers: ["https://auth.example.com"],
});

// The response sent when authentication fails; the host owns status, body and challenge.
const unauthenticated = HttpServerResponse.schemaJson(Unauthenticated)(
  new Unauthenticated({ message: "A bearer token is required." }),
  { status: 401, headers: { "www-authenticate": discovery.challenge({ error: "invalid_token" }) } },
).pipe(Effect.orDie);

const authentication = Authentication.middleware(
  CurrentActor,
  Effect.gen(function* () {
    const actor = yield* verifyToken; // Effect<Option<Actor>, never, HttpServerRequest>

    return Option.isNone(actor) ? yield* Effect.flip(unauthenticated) : actor.value;
  }),
);

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
  const client = yield* httpClient(Http.api, web.handler);

  return yield* client.greetings.greet({ payload: { name: "Ada" } });
});
```

- `httpClient(Http.api, handler, options?)` is the native grouped HTTP client calling a web handler in
  memory. `options` are the client's connection options; `baseUrl` defaults to `http://localhost`.
- `mcpRequest({ url, method, params?, headers? })` builds a stateless 2026-07-28 request.
  `params` takes whatever `JSON.stringify` accepts, `undefined` fields included, so tests can
  send malformed arguments.
  Caller `params._meta` fields override the default client capabilities
  and information; application metadata is preserved. The protocol version stays pinned to
  2026-07-28 in both the request header and metadata. Metadata is merged shallowly.
- `withMcpClient({ fetch, path, versionNegotiation?, baseUrl?, headers? }, async client => ...)`
  connects the official client and closes it in a `finally` block.
  `versionNegotiation` is passed directly to the official client (whose default is legacy).
  For a stateless endpoint, pass `versionNegotiation: { mode: { pin: "2026-07-28" } }`.
