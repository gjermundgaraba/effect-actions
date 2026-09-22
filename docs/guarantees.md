# Guarantees

Rules that hold across every adapter. Module pages link here rather than repeating them.

## Dependency lifetimes

- Handlers receive decoded input, return decoded results, and may fail only with declared errors. Anything else is a defect.
- Each surface binds its own pre-handler hook: `Http.layer(apps, { before })`, `ActionMcp.layerHttp`/`layerStdio`, `ActionToolkit.make`, `ActionCli.command`/`group`. After successful input decoding, a bound hook runs once before the selected handler and outside its span. There is no per-action opt-out; direct `build` calls bypass dispatch.
- The hook receives the selected action contract (`Action.Any`), so a policy reads `action.access`, `action.name` or `action.mcp` instead of a hand-maintained list. It is not authentication: establish identity in middleware, then let the hook authorize what that identity may do.
- It fails with the surface's own `errors`, the same list that declares what the surface answers instead of a handler, so a refusal is encoded exactly like a declared error: the schema's `httpApiStatus` on HTTP, an `isError` tool result on MCP, a returned failure on the Toolkit. `ActionCli` declares no surface errors because it does not serialize failures; there a refusal is a typed failure of the command effect.
- Its services are request-time requirements, like a handler's, and they join the adapter's request context. A local caller (`ActionCli`, `ActionToolkit`, stdio) supplies them itself.
- All surfaces decode input before dispatch. Invalid input skips the hook and handler, so unauthorized callers can receive schema errors. Use outer native HTTP middleware for admission that must run before decoding; a pre-handler hook does not provide that guarantee.
- Build-time services are those yielded in the `implement` builder Effect. They resolve once per adapter layer, in that layer's scope. An implementation served by two adapters is built twice. Share state through a Layer provided to the adapters, never through the builder.
- Request-time services are those yielded inside a handler. For HTTP-hosted adapters (`ActionHttp`, `ActionMcp.layerHttp`) they appear as `HttpRouter.Request.From<"Requires", R>` and are supplied by router middleware, `HttpRouter.provideRequest`, or request context. For `ActionToolkit`, `ActionCli`, and `ActionMcp.layerStdio` the host supplies them at invocation.
- Use distinct tags for build-time capabilities and request-scoped identity. Never provide an identity or tenant tag in a startup layer or root context. The adapters use native Effect context capture and merging: a startup value under a tag can shadow a request value or satisfy a missing one. Types verify presence, not provenance.
- Authentication must establish identity on every protected request. Types cannot verify that a handler performed authorization; the `before` hook is the one place the library guarantees runs before the handler, so put the check there rather than in each handler.
- `access` is contract metadata, required on every action and kept as a literal type. It supplies the default MCP `readOnly` hint and the `action.access` span/log annotation, but enforces no authorization. A hook can switch on what an action does instead of on its name. The catalog omits it.
- `ActionCli` acquires the implementation per invocation and releases it after the call. `ActionToolkit.make(...).layer` acquires it once for the layer's lifetime.

## Wire behavior

Defaults without a schema-error policy. HTTP is a native `HttpApi`; MCP is a native `McpServer` with one `Tool` per action. The library defines no error types of its own.

| Case                        | HTTP                                                                                                  | MCP                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Input                       | decoded with the schema's JSON codec; failure is an empty **400**                                     | decoded with the schema's JSON codec; failure is `InvalidParams`, presented as an `isError` result     |
| Success                     | the success codec's encoding as the body: `{"id":"1","name":"Ada"}`, `42`                             | `structuredContent: { value: <encoded> }`                                                              |
| Declared error              | encoded by its schema with its `httpApiStatus` (unannotated: 500): `{"_tag":"UserNotFound","id":"x"}` | `isError: true`; text content is the same JSON; no `structuredContent`                                 |
| Pre-handler hook failure    | the same, using the hook's error schema, after input decoding; the handler never runs                 | the same `isError` result, after arguments are decoded; the handler never runs                         |
| Invalid output encoding     | empty **400** (`HttpApiSchemaError`)                                                                  | `isError: true`, text `Tool execution failed due to an internal server error.`; cause logged, not sent |
| Defect                      | empty **500**                                                                                         | same generic `isError` result; cause logged, not sent                                                  |
| Unknown path or method      | 404                                                                                                   | n/a                                                                                                    |
| Invalid JSON / content type | 400 / 415                                                                                             | n/a                                                                                                    |

- A group `schemaError` policy replaces the empty 400s on HTTP with a declared error and status. It never affects MCP. Details in [ActionGroup.md](ActionGroup.md).
- `ActionHttp` sets no cache policy. The host owns cache and challenge headers; `Authentication.middleware` independently sets `Cache-Control: no-store`. POST default non-cacheability is not equivalent to an explicit storage prohibition. Hook refusals and handler failures are ordinary declared error responses.
- Routes are `POST <apiPath>/<group>/<action>`. Operation IDs are `<group>.<action>`. Effect generates OpenAPI component names and references.
- `ActionHttp.make`'s `errors` are declared on every endpoint so clients decode the surface's own failures (401, 403, 429, 503). They are produced by middleware or by the binding's hook, never by a handler. `ActionMcp` and `ActionToolkit` declare their own `errors` the same way, joined into every tool's failure schema. Two errors may share an HTTP status; their `_tag`s must differ, because the client decodes a status by trying the schemas declared for it.
- HTTP strips undeclared input fields. MCP tools are strict (`Tool.Strict`): undeclared arguments are an invalid-arguments result and input schemas publish `additionalProperties: false`. HTTP is not strict, and cannot be made strict without a hack: Effect merges one `HttpApi.ParseOptions` per endpoint and uses it for payload decoding _and_ error encoding, so `onExcessProperty: "error"` also rejects a `TaggedError` instance's own `message` and `stack`, turning a declared 409 into an empty 500. Making the payload schema itself strict would require wrapping it in an open schema, which erases its OpenAPI shape. Declare the fields you accept and treat extra HTTP fields as ignored.

## Namespaces

- Group names are unique within one `ActionHttp.make`. Action names are unique within a group. MCP tool names are unique within a group and within each Toolkit or MCP projection that serves it.
- Adapters validate only the namespace they serve. HTTP does not check tool names; MCP does not check route names.
- Each adapter builds only what it serves. A group with no HTTP actions is not built by `Http.layer`; a group with no tools is not built by MCP or Toolkit.

## Observability

- Each handler runs in a span named `<group>.<action>`, a child of the transport's request span, with attributes `action.group`, `action.name` and `action.access`. Every log line the handler writes carries the same three annotations. The pre-handler hook, decoding and encoding happen outside the handler span.
- MCP defects and encoding failures are logged with their cause and answered generically.

## MCP transport

- `protocols` is required. Effect owns negotiation, revision rejection, and session lifecycle; the adapter forwards the selection unchanged. `[McpProtocol.v2026_07_28]` is a stateless endpoint.
- `layerHttp` is single-endpoint Streamable HTTP, never two-endpoint HTTP+SSE, whatever revision is selected.
- Cancellation is Effect's native RPC interruption.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates names, not application context.

## Scope

- HTTP is JSON `POST` on `HttpApi`, not Effect RPC. MCP is native `McpServer`, no SDK runtime dependency.
- Actions are unary: no streaming, uploads, prompts, resources, retries, or code-execution sandbox.
- Authentication and authorization are the application's. The library supplies the seams: `Authentication.middleware` for identity, one `before` hook per surface for the authorization rule, `access` for what a rule reads, and each surface's `errors` for what a caller can decode. It defines no error types, no scopes and no verifier. Tool discovery is not filtered by actor. Production needs real token validation, MCP authorization discovery, request limits, and error reporting.
- The catalog is descriptive. Presence in it grants nothing.
