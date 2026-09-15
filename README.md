# effect-actions

Define an action contract once, implement it once, expose it through **HTTP RPC and MCP**.

This is a runnable design experiment, not a published or production-ready package. It tracks **Effect `main`** (a [pkg.pr.new](https://pkg.pr.new) snapshot of commit `4e4a3a6`, ahead of `4.0.0-rc.115`) because the native MCP server with the 2026-07-28 protocol adapter has landed there but not yet in a published rc. Both adapters are Effect-native: HTTP uses `HttpApi`/`HttpApiBuilder`/`HttpRouter`; MCP uses `effect/unstable/ai`'s `McpServer`. There is no MCP SDK runtime dependency; the official `@modelcontextprotocol/client` is a dev dependency used only to prove interoperability in tests.

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
The public entry points are `effect-actions`, `effect-actions/Action`,
`effect-actions/ActionGroup`, `effect-actions/http`, and `effect-actions/mcp`.
Internal implementation bindings are not exported.

`vp run dev` watches the library build; `vp run example` starts the example
HTTP/MCP server. `vp check` runs formatting, linting, and type checks.
The package remains private while it depends on the unreleased Effect snapshot. The project-local pnpm configuration permits the snapshot's transitive tarball dependency and explicitly approves the esbuild install script used by the example runner.

## The library shape

### 1. Define pure contracts

```ts
import { Schema } from "effect";
import { Action, ActionGroup } from "effect-actions";
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

- `ActionHttp.layer(App, { prefix?, openapiPath? })` registers `POST <prefix>/<name>` per HTTP-enabled action plus `GET /openapi.json` (default prefix `/api/actions`). It registers nothing for an MCP-only group. Set `openapiPath: false` to let the host serve one combined document for multiple groups.
- `ActionHttp.api(Actions)` / `ActionHttp.openapi(Actions)` give the native `HttpApi` (for `HttpApiClient`) and the OpenAPI document.
- `ActionMcp.layer(App, { name, version, path?, protocols?, allowedOrigins?, instructions? })` mounts `McpServer.layerHttp` at `/mcp` with every published protocol revision and registers one tool per MCP-enabled action. Tool input JSON Schema is compiled at Layer construction; a non-object root fails there.

[`examples/auth.ts`](examples/auth.ts) is the application's policy: `CurrentActor`, `Forbidden`, `Unauthenticated`, `authorize`. [`examples/app.ts`](examples/app.ts) wires authentication and both transports. [`examples/server.ts`](examples/server.ts) serves the result with `HttpRouter.serve` and `NodeHttpServer.layer`.

### HTTP schema-error policy

By default, HTTP retains Effect’s native empty 400 for decoding/encoding failures.
Applications can instead supply one service-free policy to the contract and adapter:

```ts
const httpOptions = {
  schemaError: {
    errors: [BadRequest, InternalServerError], // application-owned schemas
    map: (failure) =>
      failure.kind === "Body" || failure.kind === "ResponseHeaders"
        ? new InternalServerError({ error: "Request could not be completed" })
        : new BadRequest({ error: "Invalid request" }),
  },
} satisfies ActionHttp.Options<readonly [typeof BadRequest, typeof InternalServerError]>;
const api = ActionHttp.api(Actions, httpOptions);
const routes = ActionHttp.layer(App, httpOptions);
```

Policy error schemas are included in the generated client types and OpenAPI;
the mapper can only return a declared error. Native schema-error middleware runs
inside the isolated handler build: startup application services still cannot
become request fallbacks. Mapping changes only HTTP schema failures, not domain
errors, defects, media-type handling, or MCP. Keep persisted/provider-data
validation in application services when both transports need a typed domain error.

## Wire behaviour

Transport status and protocol error handling use Effect's native behaviour. The MCP adapter wraps successful values in `{ value }` and publishes declared errors as-is; the library defines no application error types.

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

## What the spike proves

`vp test` exercises:

- Generated native HTTP RPC endpoints, configurable prefixes, MCP-only groups, and runtime codec integration with `HttpApiClient` (including exact per-action client inference).
- MCP discovery and execution using hand-crafted stateless 2026-07-28 requests **and the official v2 client in legacy (2025-11-25) and pinned 2026-07-28 modes**, including structured `isError` results.
- Bidirectional write/read parity through one memoized implementation; scoped acquisition runs once across transports, finalizes once, and is fresh in another runtime.
- Input/output transformations, optional inputs, per-error HTTP statuses and native defaults, native validation errors, output-encoding failures and defect sanitization on both transports.
- Application-owned authorization on every call over both transports, actor spoofing via arguments and `_meta`, concurrent tenant isolation, and build-time vs request-time service resolution.
- Request-provided services win over a startup copy on **both** transports, whether the copy is provided to the routes' build or present in the runtime context. With no request service, a build-only copy cannot satisfy execution: HTTP fails with 500 and modern/legacy MCP fails with a sanitized internal error.
- Independent implementations of the same contract stay separate across HTTP prefixes and MCP endpoints; non-object MCP error schemas fail at Layer construction.
- Host authentication middleware and request logging/tracing survive adapter isolation.
- Interruption/finalization at the HTTP runtime boundary.
- Self-contained recursive MCP JSON Schema (`$defs`) with escaped identifiers, startup validation of tool input, and native OpenAPI reference resolution including declared error responses.

`vp check` also verifies negative type assertions: missing handlers, wrong input/result/error types, unresolved build-time services, and a missing request-scoped service on **both** transports. Implementation bindings and erased dispatch helpers are not public API; callers cannot extract or cross-wire handler tags and Layers. Test helpers also reject missing request Layers.

The internal `handlerFor` dispatch erases each handler's request requirements, which the adapters' Layers declare instead. That assertion is not evidence of authentication or service provenance. **Construction isolation** prevents build-only application services from becoming request fallbacks: HTTP builds its native handler group with an empty context; MCP builds its native server with only a router registration capability. That capability preserves host middleware during route registration without passing the host's application context into the MCP runtime. Each MCP endpoint owns its native registry/session state, while application handler acquisition remains shared.

## Deliberate limits / next experiments

- **Tracks unreleased Effect.** Repin to the next rc once it ships; only `ActionMcp` depends on APIs newer than rc.115.
- **Authentication and authorization are application policy.** Missing request dependencies are compile errors, and build-only services do not leak into request execution. The library cannot distinguish an authenticated identity from a value the host explicitly supplies in the request context. A handler that forgets `authorize` has no per-action authorization check; use application-owned handler wrappers if enforcement is needed.
- **Implementations are opaque.** Each `implement` call owns a private binding. There is no public handler service or implementation Layer to substitute; wire domain-service Layers around the adapters instead.
- **Tool discovery is not filtered per actor.** Native `McpServer` registers tools once; its visibility hook (`EnabledWhen`) sees protocol/client info, not the request.
- **HTTP RPC + MCP only.** Ordinary JSON POST endpoints, not the Effect RPC wire protocol; unary JSON actions only. No streaming, uploads, prompts/resources, elicitation, jobs, or retries.
- Schema codecs must not require services; handler dependencies can. Both transports lower schemas with `Schema.toCodecJson`, so declaration types such as `Schema.Date` encode to their JSON form.
- Demo bearer authentication is not OAuth. Production needs token validation, audience/resource checks, MCP authorization discovery, body limits and an operational error-reporting policy. `HttpApiMiddleware.Service` with `security: { bearer }` is the native way to document the scheme in OpenAPI.
- MCP cancellation is Effect's native RPC interruption; remote cancellation/disconnect behaviour needs broader client and deployment testing.
- Runtime-loaded plugins, API evolution/versioning and provider-specific schema restrictions are future work.

## Files to start with

- [`examples/README.md`](examples/README.md): a short walkthrough and request flow.
- [`examples/contracts.ts`](examples/contracts.ts): action author experience.
- [`examples/auth.ts`](examples/auth.ts): the application's identity and authorization policy.
- [`examples/handlers.ts`](examples/handlers.ts): the exhaustive implementation.
- [`examples/users.ts`](examples/users.ts): tenant-scoped in-memory domain service.
- [`examples/app.ts`](examples/app.ts): authentication and transport wiring in one Layer graph.
- [`src/Action.ts`](src/Action.ts): contracts.
- [`src/ActionGroup.ts`](src/ActionGroup.ts): groups and `implement`.
- [`src/ActionHttp.ts`](src/ActionHttp.ts), [`src/ActionMcp.ts`](src/ActionMcp.ts): adapters.
- [`tests/types.ts`](tests/types.ts): compile-time guarantees.
- [`tests/bindings.test.ts`](tests/bindings.test.ts): context isolation, private binding lifetimes, and MCP endpoint independence.
- [`docs/research/effect-v4-api-mcp.md`](docs/research/effect-v4-api-mcp.md): prior design research.
