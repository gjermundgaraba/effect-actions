# Guarantees

Rules that hold across every surface. Module pages state what is their own and link here for the rest.

## Dependency lifetimes

- Handlers receive decoded input, return decoded results, and may fail only with declared errors. Anything else is a defect.
- Build-time services are those yielded in the builder Effect passed to `implement`. The builder is a layer Effect memoizes. Within one layer graph it runs once, however many surfaces serve its implementation (HTTP layers, MCP endpoints, a Toolkit) and however many implementations `Action.share` it, and its scope is the host's.
- `HttpRouter.serve` and `Testing.layer` build their routes in a graph of their own, which reuses what the host has already built but shares nothing it builds itself. Provide `Action.layer(implementations)` above them and every other surface: it builds each builder first, once for all of them, with the services it is given.
- It runs again only in a separately built layer graph, such as a second `Testing.layer`, and not at all where no surface serves it. A local `ActionCli` command is the exception: it builds the selected implementation per invocation, even where the host already built it, and releases it after the call, once the handler's and the hook's own finalizers have run.
- **Without `Action.layer`, the builder runs with whichever surface's services Effect builds it with first.** Services provided around one surface reach the others too, so provide its startup services once, to `Action.layer` above every surface that serves it, and give surfaces different services by giving them different implementations.
- Request-time services are those yielded inside a handler or the hook. For HTTP-hosted surfaces (`ActionHttp`, `ActionMcp.layerHttp`) they appear as `HttpRouter.Request.From<"Requires", R>` and are supplied by router middleware around the surface, authentication included, `HttpRouter.provideRequest`, or request context. For `ActionToolkit`, `ActionCli`, and `ActionMcp.runStdio` the host supplies them at invocation.
- Use distinct tags for build-time capabilities and request-scoped identity. Never provide an identity or tenant tag in a startup layer or root context. The surfaces use native Effect context capture and merging: a startup value under a tag can shadow a request value or satisfy a missing one. Types verify presence, not provenance.

## Authorization

- An implementation carries its hook: `Action.implement(actions, handlers, before)`. Every surface serving it runs the hook. No surface takes a hook of its own, so none can leave it out.
- `before` runs once per call, after input decodes, before the selected handler and outside its span. It runs on `ActionHttp`, `ActionMcp` over HTTP and stdio, `ActionToolkit`, and a local `ActionCli` command. There is no per-action opt-out; calling a handler function directly bypasses dispatch.
- Authentication establishes identity for remote callers. It is router middleware, such as `Authentication.make`, that the host provides around the HTTP surfaces it covers (`ActionHttp.layer`, `ActionMcp.layerHttp`). It runs before decoding and provides the identity to the hook and handlers.
- A handler or hook that reads the identity requires authentication, in its types, on every HTTP surface serving it. One that reads none is public unless authentication covers it, so wrap every layer serving an implementation that must be authenticated. On a local surface the host provides the identity. An implementation without a hook authorizes nothing.
- The hook receives the selected action contract, typed as the implementation's own actions, so a policy reads `action.access` or `action.name` instead of a hand-maintained list. It is not authentication: authentication establishes identity, then the hook authorizes what that identity may do.
- It fails only with a refusal, `Action.Unauthenticated` or `Action.Forbidden`; anything else is a type error. Every surface declares both, so a refusal is encoded like a declared error: HTTP sends its JSON with 401 or 403, MCP an `isError` tool result, the Toolkit a returned failure. A step-up refusal under `Authentication.make` is the one exception, below.
- The CLI encodes nothing: a refusal is a typed failure of the command effect. Its error channel includes `Action.BuiltIn` for every implementation.
- Its services are request-time requirements, like a handler's, and they join the surface's request context. A local caller (`ActionCli`, `ActionToolkit`, stdio) supplies them itself.
- A step-up refusal is one an OAuth client acts on: `Unauthenticated`, or a `Forbidden` naming `scopes`. On a route `Authentication.make` covers, `ActionHttp`'s or `ActionMcp.layerHttp`'s, it answers the request with its HTTP status, 401 or 403, its JSON and its challenge, whether the hook or a handler fails with it.
- Over MCP that answer replaces the tool result, as MCP authorization defines, unless a handler's notification already started the response ([ActionMcp.md](ActionMcp.md#rules)). Without `Authentication.make` there is no OAuth client to step up: it is answered like a declared error, and the model reads it.
- A `Forbidden` naming scopes carries the `insufficient_scope` challenge an OAuth client re-authorizes on ([Authentication.md](Authentication.md#rules)). A `Forbidden` naming no scopes is always answered like a declared error.
- All surfaces decode input before dispatch. Invalid input skips the hook and handler, so unauthorized callers can receive schema errors (HTTP's `InvalidInput` message describes the input's schema). To refuse a caller before decoding, use authentication or other native HTTP middleware around the surface; the `before` hook runs too late for that.
- Authentication must establish identity on every protected request. Types cannot verify that a handler performed authorization; the `before` hook is the one place the library guarantees runs before the handler, so put an action's authorization there rather than in each handler. A check on one record, such as whether this actor may rename this user, needs the input and its data: make it in the handler's data access.
- `access` is contract metadata, required on every action and kept as a literal type. It is a tool's read-only hint, the default `destructive` hint and the `action.access` span/log annotation, but enforces no authorization. A hook can switch on what an action does instead of on its name.

## Wire behavior

HTTP is a native `HttpApi`; MCP is a native `McpServer` with one `Tool` per action. The
built-in errors are `Action.InvalidInput` (400), `Action.Unauthenticated` (401) and
`Action.Forbidden` (403), each `{ _tag, message }`.

| Case                        | HTTP                                                                                                  | MCP                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Input                       | decoded with the schema's JSON codec; failure is **400** `InvalidInput`, `message` the schema issues  | decoded with the schema's JSON codec; failure is `InvalidParams`, presented as an `isError` result                         |
| Success                     | the success codec's encoding as the body: `{"id":"1","name":"Ada"}`, `42`                             | `structuredContent: { value: <encoded> }`                                                                                  |
| Declared error              | encoded by its schema with its `httpApiStatus` (unannotated: 422): `{"_tag":"UserNotFound","id":"x"}` | `isError: true`; text content is the same JSON; no `structuredContent`                                                     |
| `before` refusal            | **401** / **403** with the refusal's JSON, after input decoding; the handler never runs               | the same `isError` result, after arguments are decoded; under `Authentication.make` a step-up refusal is **401** / **403** |
| Invalid output encoding     | a defect: empty **500**                                                                               | `isError: true`, text `Tool execution failed due to an internal server error.`; cause logged, not sent                     |
| Defect                      | empty **500**                                                                                         | same generic `isError` result; cause logged, not sent                                                                      |
| Unknown path or method      | 404                                                                                                   | n/a                                                                                                                        |
| Invalid JSON / content type | 400 `InvalidInput` / 415 for a non-JSON type; none is read as JSON                                    | n/a                                                                                                                        |

- The HTTP surfaces set no header of their own; handler failures are ordinary declared error responses. Under `Authentication.make`, a `Forbidden` naming scopes carries `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`.
- `Authentication.make` marks every response of the routes it covers `Cache-Control: no-store`, unless its route states its own caching. It gives every 401 among them without a challenge its own, whether authentication, a hook or a handler answers it. As a protected resource, it names its metadata URL in every challenge, and a 401's names `scopesRequired`, and `invalid_token` when the request presented credentials ([Authentication.md](Authentication.md#rules)).
- A 401 carries a challenge only under `Authentication.make`, so authenticate with it whatever the credential. Middleware of your own sets its own.
- Routes are `POST <prefix>/<action>`; the prefix defaults to `/api`. Operation IDs are the action names. Effect generates OpenAPI component names and references.
- Every HTTP endpoint and every tool declares `InvalidInput`, `Unauthenticated` and `Forbidden` beyond the action's own errors, and an endpoint its binding's too, so typed callers decode them. Any handler may fail with them; no action or binding lists them, and no error of its own may reuse their tags.
- They are produced by decoding, by authentication, by a hook, or by any handler. Errors reachable from one endpoint have distinct `_tag`s, because the client decodes a status by trying the schemas declared for it: `implement` refuses an action whose errors share one, and `ActionHttp.layer` an action whose error shares one with its binding's. A built-in error is always tried first, so a loose schema of an action's, such as `Schema.Struct({ message: Schema.String })`, never captures one.
- HTTP refuses undeclared input fields, nested ones too: the request is a 400 `InvalidInput` naming the field's path. A client drops them when it encodes, since TypeScript lets a wider value through. A record accepts every key its key schema does. A CLI command refuses them too, with a `SchemaError`, in `--input` and in a flag's JSON. A Toolkit drops them, as Effect decodes a model's tool call. An action without input, `input: {}` given or not, accepts only `{}`, on every surface; over HTTP, a missing body is a 400. MCP tools are strict (`Tool.Strict`): undeclared arguments are an invalid-arguments result and input schemas publish `additionalProperties: false`.

## Names

- Action names are unique within one HTTP binding; two bindings with different prefixes may reuse one, but then cannot be combined into one `HttpApi`. A tool is named after its action, so action names are also unique within each Toolkit or MCP endpoint that serves them, and kebab-case command names within each aggregate CLI command.
- Surfaces validate only the names they serve. HTTP does not check tool names; MCP does not check route names.
- Each surface serves every action of the implementations it is given, and builds only their builders.
- Surfaces match an implementation to a contract by object identity, never by name. `ActionHttp.layer` refuses an implementation of an action its binding does not hold; `ActionCli.command` refuses an action with no implementation in its list.

## Observability

- Each handler runs in a span named after its action, a child of the transport's request span, with attributes `action.name` and `action.access`. Every log line the handler writes carries the same two annotations. Names are unique per binding; the request span's route tells two bindings' same-named actions apart. The pre-handler hook, decoding and encoding happen outside the handler span.
- MCP defects and encoding failures are logged with their cause and answered generically.

## MCP transport

- HTTP serves MCP 2026-07-28 only, which is stateless: every request stands alone. The stateful revisions keep a session per `initialize`, which Effect's HTTP runtime never expires and no identity owns.
- Stdio serves 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, as the host negotiates. A success is the same `{ value }` text on each; revisions before 2025-06-18 have no `structuredContent` to repeat it in, and 2024-11-05 no tool hints. There is no option to select others; Effect owns version checks.
- `layerHttp` is single-endpoint Streamable HTTP, never two-endpoint HTTP+SSE.
- Cancellation is Effect's native RPC interruption. Without an HTTP session, `notifications/cancelled` interrupts nothing over HTTP; a call ends with its request.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates names, not application context.

## Scope

What the package does, and nothing else:

- HTTP means JSON `POST` endpoints built on Effect's `HttpApi`. It is not Effect RPC.
- MCP means one native `McpServer` `Tool` per action, over MCP 2026-07-28, and over stdio every earlier revision from 2024-11-05 too. There is no MCP SDK runtime dependency.
- Actions are unary: one decoded input, one decoded success or one declared error. No streaming, uploads, prompts, resources, retries, or code-execution sandbox.
- Authentication and authorization are the application's. The library supplies the seams:
  - `Authentication.make`, native router middleware for identity;
  - one `before` hook for the authorization rule, bound to an implementation and run by every surface;
  - `access`, for what a rule reads;
  - the built-in refusals every caller decodes.
- It defines no scopes and no verifier: a refusal names the scopes a call lacks, and the library answers with the OAuth challenge. Tool discovery is not filtered by actor. Production needs real token validation, request limits, and error reporting.
