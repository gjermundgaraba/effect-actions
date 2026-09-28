# Guarantees

Rules that hold across every surface. Module pages state what is their own and link here for the rest.

## Dependency lifetimes

- Handlers receive decoded input, return decoded results, and may fail only with declared errors. Anything else is a defect.
- An implementation carries its hook: `Action.implement(actions, handlers, before)`. Every surface serving it runs the hook. No surface takes a hook of its own, so none can leave it out.
- `before` runs once per call, after input decodes, before the selected handler and outside its span. It runs on `ActionHttp`, `ActionMcp` over HTTP and stdio, `ActionToolkit`, and a local `ActionCli` command. There is no per-action opt-out; calling a handler function directly bypasses dispatch.
- Authentication establishes identity for remote callers. It is router middleware, such as `Authentication.make`, that the host provides around the HTTP surfaces it covers (`ActionHttp.layer`, `ActionMcp.layerHttp`). It runs before decoding and provides the identity to the hook and handlers.
- A handler or hook that reads the identity requires authentication, in its types, on every HTTP surface serving it. One that reads none is public unless authentication covers it, so wrap every layer serving an implementation that must be authenticated. On a local surface the host provides the identity. An implementation without a hook authorizes nothing.
- The hook receives the selected action contract, typed as the implementation's own actions, so a policy reads `action.access` or `action.name` instead of a hand-maintained list. It is not authentication: authentication establishes identity, then the hook authorizes what that identity may do.
- It fails only with a refusal, `Action.Unauthenticated` or `Action.Forbidden`; anything else is a type error. Every surface declares both, so a refusal is encoded exactly like a declared error: HTTP sends its JSON with 401 or 403, MCP an `isError` tool result, the Toolkit a returned failure.
- The CLI encodes nothing: a refusal is a typed failure of the command effect. Its error channel includes `Action.Refusal` for every implementation.
- Its services are request-time requirements, like a handler's, and they join the surface's request context. A local caller (`ActionCli`, `ActionToolkit`, stdio) supplies them itself.
- A step-up refusal is `Unauthenticated`, or a `Forbidden` naming `scopes`. On the HTTP surfaces, `ActionHttp` and `ActionMcp.layerHttp`, it is answered with its HTTP status, 401 or 403, and its JSON, whether the hook or a handler fails with it.
- Over MCP that answer replaces the tool result, as MCP authorization defines, unless a handler's notification already started the response ([ActionMcp.md](ActionMcp.md#rules)).
- A `Forbidden` naming scopes carries the `insufficient_scope` challenge an OAuth client re-authorizes on ([Authentication.md](Authentication.md#rules)). Every other failure, a `Forbidden` naming no scopes included, is answered like a declared error.
- All surfaces decode input before dispatch. Invalid input skips the hook and handler, so unauthorized callers can receive schema errors (HTTP's `InvalidInput` message describes the input's schema). To refuse a caller before decoding, use authentication or other native HTTP middleware around the surface; the `before` hook runs too late for that.
- Build-time services are those yielded in the builder Effect passed to `implement`. The builder is a layer Effect memoizes. Within one build of the host's layers it runs once, however many surfaces serve its implementation (HTTP layers, MCP endpoints, a Toolkit), and its scope is the host's.
- It runs again only in a separately built layer graph, such as a second `Testing.layer`, and not at all where no surface serves it. A local `ActionCli` command is the exception: it builds the selected implementation per invocation and releases it after the call.
- **The builder runs with whichever surface's services Effect builds it with first.** Services provided around one surface reach the others too, so provide its startup services once, above every surface that serves it, and give surfaces different services by giving them different implementations.
- Request-time services are those yielded inside a handler or the hook. For HTTP-hosted surfaces (`ActionHttp`, `ActionMcp.layerHttp`) they appear as `HttpRouter.Request.From<"Requires", R>` and are supplied by router middleware around the surface, authentication included, `HttpRouter.provideRequest`, or request context. For `ActionToolkit`, `ActionCli`, and `ActionMcp.layerStdio` the host supplies them at invocation.
- Use distinct tags for build-time capabilities and request-scoped identity. Never provide an identity or tenant tag in a startup layer or root context. The surfaces use native Effect context capture and merging: a startup value under a tag can shadow a request value or satisfy a missing one. Types verify presence, not provenance.
- Authentication must establish identity on every protected request. Types cannot verify that a handler performed authorization; the `before` hook is the one place the library guarantees runs before the handler, so put the check there rather than in each handler.
- `access` is contract metadata, required on every action and kept as a literal type. It is a tool's read-only hint, the default `destructive` hint and the `action.access` span/log annotation, but enforces no authorization. A hook can switch on what an action does instead of on its name.

## Wire behavior

HTTP is a native `HttpApi`; MCP is a native `McpServer` with one `Tool` per action. The
built-in errors are `Action.InvalidInput` (400), `Action.Unauthenticated` (401) and
`Action.Forbidden` (403), each `{ _tag, message }`.

| Case                        | HTTP                                                                                                  | MCP                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Input                       | decoded with the schema's JSON codec; failure is **400** `InvalidInput`, `message` the schema issues  | decoded with the schema's JSON codec; failure is `InvalidParams`, presented as an `isError` result       |
| Success                     | the success codec's encoding as the body: `{"id":"1","name":"Ada"}`, `42`                             | `structuredContent: { value: <encoded> }`                                                                |
| Declared error              | encoded by its schema with its `httpApiStatus` (unannotated: 422): `{"_tag":"UserNotFound","id":"x"}` | `isError: true`; text content is the same JSON; no `structuredContent`                                   |
| `before` refusal            | **401** / **403** with the refusal's JSON, after input decoding; the handler never runs               | the same `isError` result, after arguments are decoded; over HTTP a step-up refusal is **401** / **403** |
| Invalid output encoding     | a defect: empty **500**                                                                               | `isError: true`, text `Tool execution failed due to an internal server error.`; cause logged, not sent   |
| Defect                      | empty **500**                                                                                         | same generic `isError` result; cause logged, not sent                                                    |
| Unknown path or method      | 404                                                                                                   | n/a                                                                                                      |
| Invalid JSON / content type | 400 `InvalidInput` / 415 for a non-JSON type; none is read as JSON                                    | n/a                                                                                                      |

- The HTTP surfaces set one header of their own: a `Forbidden` naming scopes carries `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`. Handler failures are otherwise ordinary declared error responses.
- `Authentication.make` marks every response of the routes it covers `Cache-Control: no-store`, unless its route states its own caching. It gives every 401 among them without a challenge its own, whether authentication, a hook or a handler answers it. As a protected resource, it names its metadata URL in every challenge, and a 401's names `scopesRequired` ([Authentication.md](Authentication.md#rules)).
- A 401 carries a challenge only under `Authentication.make`, so authenticate with it whatever the credential. Middleware of your own sets its own.
- Routes are `POST <prefix>/<action>`; the prefix defaults to `/api`. Operation IDs are the action names. Effect generates OpenAPI component names and references.
- Every HTTP endpoint declares `InvalidInput`, `Unauthenticated` and `Forbidden` beyond the action's own errors, and every tool `Unauthenticated` and `Forbidden`, so typed callers decode them. An action lists one in `errors` only when its handler fails with it. An error of your own may not reuse their tags.
- They are produced by decoding, by authentication or by a hook, never by a handler whose action does not list them. Errors reachable from one endpoint must have distinct `_tag`s, because the client decodes a status by trying the schemas declared for it.
- HTTP strips undeclared fields of a struct input: declare the fields you accept, and treat extra ones as ignored. An action without input, `input: {}` given or not, accepts only `{}`, on every surface; over HTTP, a missing body is a 400. MCP tools are strict (`Tool.Strict`): undeclared arguments are an invalid-arguments result and input schemas publish `additionalProperties: false`.

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
- Stdio serves 2026-07-28, 2025-11-25 and 2025-06-18, as the host negotiates. Earlier revisions have no `structuredContent` and are refused. There is no option to select others; Effect owns version checks.
- `layerHttp` is single-endpoint Streamable HTTP, never two-endpoint HTTP+SSE.
- Cancellation is Effect's native RPC interruption. Without an HTTP session, `notifications/cancelled` interrupts nothing over HTTP; a call ends with its request.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates names, not application context.

## Scope

What the package does, and nothing else:

- HTTP means JSON `POST` endpoints built on Effect's `HttpApi`. It is not Effect RPC.
- MCP means one native `McpServer` `Tool` per action, over MCP 2026-07-28, and over stdio 2025-11-25 and 2025-06-18 too. There is no MCP SDK runtime dependency.
- Actions are unary: one decoded input, one decoded success or one declared error. No streaming, uploads, prompts, resources, retries, or code-execution sandbox.
- Authentication and authorization are the application's. The library supplies the seams:
  - `Authentication.make`, native router middleware for identity;
  - one `before` hook for the authorization rule, bound to an implementation and run by every surface;
  - `access`, for what a rule reads;
  - the built-in refusals every caller decodes.
- It defines no scopes and no verifier: a refusal names the scopes a call lacks, and the library answers with the OAuth challenge. Tool discovery is not filtered by actor. Production needs real token validation, request limits, and error reporting.
