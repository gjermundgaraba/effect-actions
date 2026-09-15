# @gjermundgaraba/effect-actions

Define an action contract once, implement it once, expose it through **HTTP RPC and MCP**.

This is not a published or production-ready package. It tracks **Effect `main`** (a [pkg.pr.new](https://pkg.pr.new) snapshot of commit `4e4a3a6`, ahead of `4.0.0-rc.115`) because the native MCP server with the 2026-07-28 protocol adapter has landed there but not yet in a published rc. Both adapters are Effect-native: HTTP uses `HttpApi`/`HttpApiBuilder`/`HttpRouter`; MCP uses `effect/unstable/ai`'s `McpServer`. There is no MCP SDK runtime dependency; the official `@modelcontextprotocol/client` is a dev dependency used only to prove interoperability in tests.

The library is deliberately thin: **contracts, one handler binding, two projections.** Identity, authentication, authorization and error policy belong to the application. The library never sees an actor.

## Run it

Requires Node.js (24 LTS recommended) and [Vite+](https://viteplus.dev). Development uses Vite+ and a pnpm lockfile:

```sh
vp install
vp check
vp test
vp run example
```

The example listens on **127.0.0.1:3000**. It uses an in-memory repository and deliberately fake bearer tokens:

| Token    | Actor / tenant | Permissions             |
| -------- | -------------- | ----------------------- |
| `alice`  | alice / acme   | users:read, users:write |
| `reader` | reader / acme  | users:read              |
| `bob`    | bob / other    | users:read, users:write |

**Do not deploy these credentials or this authentication implementation.** State resets when the process restarts.

```sh
# A generated HTTP RPC endpoint over the getUser action
curl -s http://127.0.0.1:3000/api/actions/getUser \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -d '{"id":"1"}'
# {"id":"1","name":"Ada"}

# A generated HTTP route; the schema transforms "21" to numeric 21
curl -s http://127.0.0.1:3000/api/actions/double \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -d '{"value":"21"}'
# 42

# The same action over MCP. The 2026-07-28 revision is stateless, so a single
# request needs no initialize handshake. Older revisions negotiate a session
# first; see the official-client tests.
curl -s http://127.0.0.1:3000/mcp \
  -H 'Authorization: Bearer alice' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'MCP-Method: tools/call' \
  -H 'MCP-Name: double' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"double","arguments":{"value":"21"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"}}}}'
# ... "structuredContent":{"value":42} ...

# Generated OpenAPI 3.1 document
curl -s http://127.0.0.1:3000/openapi.json \
  -H 'Authorization: Bearer alice'
```

For MCP discovery, use `MCP-Method: tools/list` and `"method":"tools/list"` with the same `_meta`. Every actor sees the same tool list; a tool call the application's authorization rejects returns an `isError` result. The HTTP endpoint runs the same handler and therefore the same check.

## Package build

Run `vp run build` to emit ESM and TypeScript declarations into `dist/`.
The public entry points are `@gjermundgaraba/effect-actions`, `@gjermundgaraba/effect-actions/Action`,
`@gjermundgaraba/effect-actions/ActionGroup`, `@gjermundgaraba/effect-actions/http`, and `@gjermundgaraba/effect-actions/mcp`.
Internal implementation bindings are not exported.

`vp run dev` watches the library build; `vp run example` starts the example
HTTP/MCP server. `vp check` runs formatting, linting, and type checks.
The package remains private while it depends on the unreleased Effect snapshot.

## The library shape

### 1. Define pure contracts

```ts
import { Schema } from "effect";
import { Action, ActionGroup } from "@gjermundgaraba/effect-actions";
import { Forbidden } from "./examples/auth.js"; // the application's error, not the library's

const User = Schema.Struct({ id: Schema.String, name: Schema.String });
class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

const GetUser = Action.make("getUser", {
  description: "Get a user in your tenant.",
  input: Schema.Struct({ id: Schema.String }),
  success: User,
  error: [UserNotFound, Forbidden],
  mcp: { name: "get_user", readOnly: true },
});

const Actions = ActionGroup.make(GetUser);
```

`input` defaults to `Action.NoInput` (`Schema.Struct({})` does not emit the object-root JSON Schema MCP requires). `error` is a **list**, one schema per declared failure, and defaults to none; each keeps its own HTTP status annotation. For MCP-enabled actions, input and every declared error must encode to a JSON **object** (MCP `structuredContent` is an object); `ActionMcp.layer` rejects anything else at Layer construction. HTTP has no such restriction. Actions default to both transports; set `http: false` or `mcp: false` to opt out. `mcp.destructive` defaults to `!readOnly`.

### 2. Implement the group once

```ts
const App = Actions.implement(
  Effect.gen(function* () {
    const users = yield* Users; // build-time dependency, resolved once
    return {
      getUser: ({ id }) =>
        Effect.gen(function* () {
          const actor = yield* authorize("users:read"); // request-scoped: reads CurrentActor
          return yield* users.get(actor.tenantId, id);
        }),
    };
  }),
);
```

`implement` takes an exhaustive record, typed from the group's tuple: a missing or mistyped handler, an undeclared error or a wrong result is one compile error at that site. Pass a plain record when there are no build-time dependencies. `App` is an opaque implementation value: pass it to adapters, rather than extracting handler tags or an implementation Layer. Handlers receive **decoded** input and return decoded results; codecs run in the adapters.

A service yielded in the builder Effect is a build-time requirement of either adapter's Layer; a service yielded inside a handler is a **request** requirement, which both adapters surface as `HttpRouter.Request<"Requires", R>`. Request requirements are satisfied by `HttpRouter.middleware<{ provides: R }>` or at `HttpRouter.serve`; a startup `Layer.succeed(CurrentActor, …)` does not satisfy them.

### 3. Select adapters

```ts
export const layer = Layer.mergeAll(
  ActionHttp.layer(App),
  ActionMcp.layer(App, { name: "my-app", version: "0.0.0" }),
).pipe(Layer.provide(Authentication.layer), Layer.provide(Users.layerMemory));
```

Both adapters are ordinary Layers over Effect's `HttpRouter`. The implementation's private binding is memoized, so both transports share one handler build and one set of application services per runtime. Scoped handler acquisition is finalized with that runtime. Omitting the authentication middleware is a **compile error** at `HttpRouter.serve`/`toWebHandler` for HTTP and MCP alike.

| Entry point                  | Purpose                                       | Configuration                                                                  |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| `ActionHttp.layer`           | HTTP action routes and optional OpenAPI route | `prefix`, `openapiPath`, `schemaError`                                         |
| `ActionHttp.api` / `openapi` | Native client contract / OpenAPI document     | `prefix`, `schemaError`                                                        |
| `ActionHttp.client`          | Direct, typed action calls                    | `prefix`, `schemaError`, `baseUrl`, native client transforms                   |
| `ActionHttp.configure`       | Bind HTTP configuration across projections    | Same transport options as `layer`                                              |
| `ActionMcp.layer`            | Native MCP tools and protocol endpoint        | Server identity, path, protocols, allowed origins, instructions, `schemaError` |

HTTP defaults to `POST /api/actions/<name>` and `GET /openapi.json`; set
`openapiPath: false` when the host owns the document. MCP defaults to `/mcp`
with all published revisions. MCP tool schemas are checked at Layer construction.
See [shared schema-error policy](#shared-schema-error-policy) for mapping semantics.

[`examples/auth.ts`](examples/auth.ts) is the application's policy: `CurrentActor`, `Forbidden`, `Unauthenticated`, `authorize`. [`examples/app.ts`](examples/app.ts) wires authentication and both transports. [`examples/server.ts`](examples/server.ts) serves the result with `HttpRouter.serve` and `NodeHttpServer.layer`.

### Shared schema-error policy

By default, HTTP retains Effect's native empty 400 for decoding/encoding failures;
MCP retains native invalid-argument handling and treats output-encoding failures
as defects. Applications can supply the **same policy to both adapters**:

```ts
const schemaError = {
  errors: [BadRequest, InternalServerError], // application-owned schemas
  map: ({ phase }) =>
    phase === "output"
      ? new InternalServerError({ error: "Request could not be completed" })
      : new BadRequest({ error: "Invalid request" }),
} satisfies Action.SchemaErrorPolicy<readonly [typeof BadRequest, typeof InternalServerError]>;

const Http = ActionHttp.configure({ schemaError });
const api = Http.api(Actions);
const routes = Layer.mergeAll(
  Http.layer(App),
  ActionMcp.layer(App, { name: "my-app", version: "0", schemaError }),
);
```

The mapper receives `{ phase: "input" | "output", cause: Schema.SchemaError }`
and returns a declared policy error without requiring services. Causes may contain
sensitive values: do not reflect them in public messages. Policy errors augment
transport contracts, not the errors handlers may return.

HTTP uses the mapped error's status annotation and includes its schema in clients
and OpenAPI. MCP returns an `isError` tool result; policy errors must encode to
objects.

`input` covers request decoding; `output` covers successful-result encoding.
Domain errors, defects, interruptions, and protocol errors remain unchanged.
An unencodable declared error is a defect; broken policy errors are not
recursively remapped.

### Configure HTTP once

Bind options once, then reuse the configured adapter for every projection:

```ts
export const Http = ActionHttp.configure({
  prefix: "/api/actions",
  openapiPath: false, // host owns one combined document
  schemaError,
});
export const Api = Http.api(Actions);

// In server composition, keep distinct authentication boundaries:
const ownerRoutes = Http.layer(owner);
const issuerRoutes = Http.layer(issuer);
const document = Http.openapi(Actions);
```

Standalone `api(group, options)`, `openapi(group, options)`,
`layer(implementation, options)`, and `client(group, options)`
are also available. `configure` binds the same transport options for all four;
configured clients accept only `baseUrl`, `transformClient`, and `transformResponse`;
their prefix and schema policy stay bound. `openapiPath` is not a client option.

### Action-shaped HTTP client

```ts
import { Effect } from "effect";
import { ActionHttp } from "@gjermundgaraba/effect-actions";
import { Actions } from "./contracts.js";

export const lookup = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Actions, {
    baseUrl: "https://api.example.com",
  });
  const user = yield* client.getUser({ id: "1" });
  const identity = yield* client.whoAmI();
  return { user, identity };
});
```

This example is type-checked in [examples/client.ts](examples/client.ts).

Client construction requires Effect's `HttpClient` service (for example,
`FetchHttpClient.layer`). Methods take decoded inputs, return decoded results,
and retain declared domain errors, policy errors, `SchemaError`, and native
`HttpClientError`. MCP-only actions are absent. An argument is optional when the
input type accepts `{}`. Omitted input and explicit `undefined` behave alike:
they send `{}` unless the decoded input schema accepts `undefined` as a value.
`null` is always passed through unchanged.

The client delegates to `HttpApiClient`: codecs, HTTP status handling,
interruption, and HTTP service configuration are native. Client options support
`baseUrl`, `transformClient` (for authentication headers, for example), and
`transformResponse`. Local client codec failures remain `SchemaError`; the
shared policy runs on the server, not on the client.

Use `HttpApiClient.make(Http.api(Actions), options)` when you need native
per-call response modes, or `makeWith` for a custom client's additional error and
service channels. The action-shaped client always returns decoded results.
Actions named `then` require the native grouped client to avoid JavaScript thenable assimilation.

## Wire behaviour

The table below describes default behavior without a schema-error policy. Transport status and protocol error handling use Effect's native behaviour. The MCP adapter wraps successful values in `{ value }` and publishes declared errors as-is; the library defines no application error types.

|                             | HTTP (`HttpApi`)                                                                                            | MCP (`McpServer`)                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Input                       | Decoded with the schema's JSON codec; failure is an empty **400**                                           | Decoded with the schema's JSON codec; failure is `InvalidParams`, which this snapshot presents as an `isError` result with the message |
| Success                     | The success codec's encoding as the body: `{"id":"1","name":"Ada"}`, `42`                                   | `structuredContent: { value: <encoded> }` (must be an object)                                                                          |
| Declared error              | Encoded by its schema with its `httpApiStatus` (unannotated: 500): `{"_tag":"UserNotFound","id":"missing"}` | Same encoding as `structuredContent` with `isError: true`                                                                              |
| Invalid output encoding     | Empty **400** (`HttpApiSchemaError`)                                                                        | JSON-RPC `InternalError`                                                                                                               |
| Defect                      | Empty **500**                                                                                               | JSON-RPC `InternalError("Internal error")`                                                                                             |
| Unknown path / method       | 404                                                                                                         | —                                                                                                                                      |
| Invalid JSON / content type | 400 / 415                                                                                                   | —                                                                                                                                      |

Object schemas keep Effect's default excess-field behaviour (stripped unless the schema rejects them). OpenAPI component names, references and operation IDs (`actions.<name>`) are generated by Effect. `HttpApiClient` runs the same codecs as the server: `client.actions.double({ payload: { value: 21 } })` encodes to the wire string and decodes the reply to `42`. `ActionHttp.api` preserves each action’s name, decoded input, success and declared error types for `HttpApiClient`; actions declared with `http: false` are excluded from the client.

## Tests

`vp test` covers both transports end to end, including the official MCP client in legacy and 2026-07-28 modes, shared implementations across transports, schema-error policies, context isolation, and cancellation. [`tests/types.ts`](tests/types.ts) holds the compile-time assertions that `vp check` verifies: missing handlers, wrong types, and missing build-time or request-scoped services on both transports.

## Deliberate limits

- **Tracks unreleased Effect.** Repin to the next rc once it ships; only `ActionMcp` depends on APIs newer than rc.115.
- **Authentication and authorization are application policy.** Missing request dependencies are compile errors, and build-only services do not leak into request execution. The library cannot distinguish an authenticated identity from a value the host explicitly supplies in the request context. A handler that forgets `authorize` has no per-action authorization check; use application-owned handler wrappers if enforcement is needed.
- **Implementations are opaque.** Each `implement` call owns a private binding. There is no public handler service or implementation Layer to substitute; wire domain-service Layers around the adapters instead.
- **Tool discovery is not filtered per actor.** Native `McpServer` registers tools once; its visibility hook (`EnabledWhen`) sees protocol/client info, not the request.
- **HTTP RPC + MCP only.** Ordinary JSON POST endpoints, not the Effect RPC wire protocol; unary JSON actions only. No streaming, uploads, prompts/resources, elicitation, jobs, or retries.
- Schema codecs must not require services; handler dependencies can. Both transports lower schemas with `Schema.toCodecJson`, so declaration types such as `Schema.Date` encode to their JSON form.
- Demo bearer authentication is not OAuth. Production needs token validation, audience/resource checks, MCP authorization discovery, body limits and an operational error-reporting policy. `HttpApiMiddleware.Service` with `security: { bearer }` is the native way to document the scheme in OpenAPI.
- MCP cancellation is Effect's native RPC interruption; remote cancellation/disconnect behaviour needs broader client and deployment testing.
- Runtime-loaded plugins, API evolution/versioning and provider-specific schema restrictions are future work.

See [`examples/README.md`](examples/README.md) for a guided tour of the example application.
