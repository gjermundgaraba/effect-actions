# Guarantees

Rules that hold across every adapter. Module pages link here rather than repeating them.

## Dependency lifetimes

- Handlers receive decoded input, return decoded results, and may fail only with declared errors. Anything else is a defect.
- A group's pre-handler hook (`implement(handlers, { before })`) runs once per invocation on every surface, before the selected handler, inside that handler's span. It may fail only with the group's own errors, and its services are request-time requirements like a handler's. No adapter can skip it; only calling `build` directly does, and that is not dispatch.
- Build-time services are those yielded in the `implement` builder Effect. They resolve once per adapter layer, in that layer's scope. An implementation served by two adapters is built twice. Share state through a Layer provided to the adapters, never through the builder.
- Request-time services are those yielded inside a handler. For HTTP-hosted adapters (`ActionHttp`, `ActionMcp.layerHttp`) they appear as `HttpRouter.Request.From<"Requires", R>` and are supplied by router middleware, `HttpRouter.provideRequest`, or request context. For `ActionToolkit`, `ActionCli`, and `ActionMcp.layerStdio` the host supplies them at invocation.
- Use distinct tags for build-time capabilities and request-scoped identity. Never provide an identity or tenant tag in a startup layer or root context. The adapters use native Effect context capture and merging: a startup value under a tag can shadow a request value or satisfy a missing one. Types verify presence, not provenance.
- Authentication must establish identity on every protected request. Types cannot verify that a handler performed authorization; the `before` hook is the one place the library guarantees runs first, so put the check there rather than in each handler.
- `access` is contract metadata. Nothing in the library reads it: adapters ignore it and the catalog only reports it. An action defaults to `access: "write"` so a hook that fails closed does so without a list of exceptions.
- `ActionCli` acquires the implementation per invocation and releases it after the call. `ActionToolkit.layer` acquires it once for the layer's lifetime.

## Wire behavior

Defaults without a schema-error policy. HTTP is a native `HttpApi`; MCP is a native `McpServer` with one `Tool` per action. The library defines no error types of its own.

| Case                        | HTTP                                                                                                  | MCP                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Input                       | decoded with the schema's JSON codec; failure is an empty **400**                                     | decoded with the schema's JSON codec; failure is `InvalidParams`, presented as an `isError` result     |
| Success                     | the success codec's encoding as the body: `{"id":"1","name":"Ada"}`, `42`                             | `structuredContent: { value: <encoded> }`                                                              |
| Declared error              | encoded by its schema with its `httpApiStatus` (unannotated: 500): `{"_tag":"UserNotFound","id":"x"}` | `isError: true`; text content is the same JSON; no `structuredContent`                                 |
| Pre-handler hook failure    | the same, using the hook's error schema; the handler never runs                                       | the same `isError` result; the handler never runs                                                      |
| Invalid output encoding     | empty **400** (`HttpApiSchemaError`)                                                                  | `isError: true`, text `Tool execution failed due to an internal server error.`; cause logged, not sent |
| Defect                      | empty **500**                                                                                         | same generic `isError` result; cause logged, not sent                                                  |
| Unknown path or method      | 404                                                                                                   | n/a                                                                                                    |
| Invalid JSON / content type | 400 / 415                                                                                             | n/a                                                                                                    |

- A group `schemaError` policy replaces the empty 400s on HTTP with a declared error and status. It never affects MCP. Details in [ActionGroup.md](ActionGroup.md).
- Routes are `POST <apiPath>/<group>/<action>`. Operation IDs are `<group>.<action>`. Effect generates OpenAPI component names and references.
- `ActionHttp.make`'s `errors` are declared on every endpoint so clients decode the surface's own failures (401, 403, 429, 503). They are HTTP-only, produced by middleware rather than by the library, and never returnable by a handler. MCP is unaffected.
- HTTP strips undeclared input fields. MCP tools are strict (`Tool.Strict`): undeclared arguments are an invalid-arguments result and input schemas publish `additionalProperties: false`. HTTP is not strict, and cannot be made strict without a hack: Effect merges one `HttpApi.ParseOptions` per endpoint and uses it for payload decoding _and_ error encoding, so `onExcessProperty: "error"` also rejects a `TaggedError` instance's own `message` and `stack`, turning a declared 409 into an empty 500. Making the payload schema itself strict would require wrapping it in an open schema, which erases its OpenAPI shape. Declare the fields you accept and treat extra HTTP fields as ignored.

## Namespaces

- Group names are unique within one `ActionHttp.make`. Action names are unique within a group. MCP tool names are unique within a group and within each Toolkit or MCP projection that serves it.
- Adapters validate only the namespace they serve. HTTP does not check tool names; MCP does not check route names.
- Each adapter builds only what it serves. A group with no HTTP actions is not built by `Http.layer`; a group with no tools is not built by MCP or Toolkit.

## Observability

- Each handler runs in a span named `<group>.<action>`, a child of the transport's request span. Decoding and encoding happen outside the handler span.
- MCP defects and encoding failures are logged with their cause and answered generically.

## MCP transport

- `protocols` is required. Effect owns negotiation, revision rejection, and session lifecycle; the adapter forwards the selection unchanged. `[McpProtocol.v2026_07_28]` is a stateless endpoint.
- `layerHttp` is single-endpoint Streamable HTTP, never two-endpoint HTTP+SSE, whatever revision is selected.
- Cancellation is Effect's native RPC interruption.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates names, not application context.

## Scope

- HTTP is JSON `POST` on `HttpApi`, not Effect RPC. MCP is native `McpServer`, no SDK runtime dependency.
- Actions are unary: no streaming, uploads, prompts, resources, retries, or code-execution sandbox.
- Authentication and authorization are the application's. The library supplies the seams: `Authentication.middleware` for identity, `implement({ before })` for one authorization rule per group, `access` for what a rule reads, and `ActionHttp.make`'s `errors` for what a client can decode. It defines no error types, no scopes and no verifier. Tool discovery is not filtered by actor. Production needs real token validation, MCP authorization discovery, request limits, and error reporting.
- The catalog is descriptive. Presence in it grants nothing.
