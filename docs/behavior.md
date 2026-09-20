# Adapter behavior

## Dependency lifetimes

`ActionGroup.implement` takes a complete handler record or an Effect producing one.
Handlers receive decoded input, return decoded results, and may fail only with
the errors declared by their action.

Services yielded in the builder Effect are resolved at Layer construction. The
builder runs once per adapter layer that serves the implementation, in that layer's
scope, so an implementation served over HTTP and MCP is built twice. Acquire shared
state in a Layer, not in the builder. Each `implement` call owns a separate binding.
The implementation is a nominal class: it cannot be fabricated or replaced by spreading
its public properties. Its typed `build` Effect permits direct handler tests under
`Effect.scoped`; this bypasses transport validation and is not a substitute for integration
tests. It exposes no public handler service or Layer; provide domain-service Layers to
the adapters instead.

For HTTP-hosted adapters, services yielded inside a handler are request requirements, represented by
`HttpRouter.Request.From<"Requires", R>`. Supply them through router middleware,
`HttpRouter.provideRequest`, or the request context.

Use distinct tags for build-time capabilities and request-scoped identity.
For example, acquire `Users` at startup and provide `CurrentActor` only per request.
Never provide identity or tenant tags in startup layers or the application's root context.
The adapters use native Effect context capture and merging: they do not isolate arbitrary
request services from build context. A startup value under the same tag can shadow a
request value or satisfy a missing runtime value. Types still track request requirements;
they do not enforce this separation of tags or validate identity provenance.

Authentication must establish identity on every protected request. See the
[authenticated example](../examples/README.md) for this separation.

The application remains responsible for establishing identity and checking
permissions. Types verify that a required service is present, not that its value
is trustworthy or that a handler performed authorization.

## Schema-error policies

By default, HTTP retains Effect's native empty 400 for decoding/encoding failures.
A group can set a policy instead. It belongs to the contract, so the HTTP routes, the
clients and the document agree on it by construction. MCP is not affected: the native
`McpServer` toolkit answers invalid arguments and unencodable results itself, as an
`isError` tool result whose text is for the model.

```ts
import { Schema } from "effect";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import { GetUser, RenameUser } from "./examples/contracts.js";

class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}
class InternalServerError extends Schema.TaggedError<InternalServerError>()(
  "InternalServerError",
  { error: Schema.String },
  { httpApiStatus: 500 },
) {}

const UserActions = ActionGroup.make(
  {
    name: "users",
    schemaError: {
      errors: [BadRequest, InternalServerError],
      map: ({ kind }) =>
        kind === "Body" || kind === "ResponseHeaders"
          ? new InternalServerError({ error: "Request could not be completed" })
          : new BadRequest({ error: "Invalid request" }),
    },
  },
  GetUser,
  RenameUser,
);
```

Written inline, `map` is typed from `errors`. A policy shared by several groups is an
ordinary constant; annotate its parameter as `HttpApiError.HttpApiSchemaError` (a type import from `effect/unstable/httpapi`). Groups served by one
adapter may have different policies: each action answers with its own group's.

The mapper receives Effect's native `HttpApiSchemaError` with `kind` and `cause`
and returns a declared policy error without requiring services. Causes may contain
sensitive values: do not reflect them in public messages. Policy errors augment
transport contracts, not the errors handlers may return.

HTTP uses the mapped error's status annotation and includes its schema in clients
and OpenAPI.

`Payload` covers action input decoding; `Body` covers successful-result encoding.
The native error also distinguishes parameters, request headers, query and response headers.
Domain errors, defects, interruptions, and protocol errors remain unchanged.
An unencodable declared error is a defect; broken policy errors are not
recursively remapped.

## Wire behavior

The table below describes default behavior without a schema-error policy. Transport status and protocol error handling use Effect's native behavior: HTTP is an `HttpApi`, MCP is a native `McpServer` toolkit with one `Tool` per action. The MCP adapter wraps successful values in `{ value }`, since `structuredContent` must be an object. Declared errors follow MCP's own convention: an `isError` result whose text content is the error's JSON encoding, the same bytes HTTP sends as the body. The library defines no application error types.

|                             | HTTP (`HttpApi`)                                                                                            | MCP (`McpServer`)                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Input                       | Decoded with the schema's JSON codec; failure is an empty **400**                                           | Decoded with the schema's JSON codec; failure is `InvalidParams`, which McpServer presents as an `isError` result with the message |
| Success                     | The success codec's encoding as the body: `{"id":"1","name":"Ada"}`, `42`                                   | `structuredContent: { value: <encoded> }`                                                                                          |
| Declared error              | Encoded by its schema with its `httpApiStatus` (unannotated: 500): `{"_tag":"UserNotFound","id":"missing"}` | `isError: true`; text content `{"_tag":"UserNotFound","id":"missing"}`; no `structuredContent`                                     |
| Invalid output encoding     | Empty **400** (`HttpApiSchemaError`)                                                                        | `isError: true`, text `Tool execution failed due to an internal server error.`; the cause is logged, not sent                      |
| Defect                      | Empty **500**                                                                                               | Same generic `isError` result; the cause is logged, not sent                                                                       |
| Unknown path / method       | 404                                                                                                         | n/a                                                                                                                                |
| Invalid JSON / content type | 400 / 415                                                                                                   | n/a                                                                                                                                |

HTTP routes are `POST <apiPath>/<group>/<action>`; equal action names in distinct
groups do not collide. `Http.layer(...apps)` mounts selected implementations; separate
calls permit different middleware.

Object schemas strip excess fields unless configured to reject them. Effect generates
OpenAPI component names, references, and operation IDs (`<group>.<action>`).

Each handler runs in a span named by that operation ID, a child of the transport's request
span, so a trace names the action on both transports. Decoding and encoding happen outside it.

## HTTP client details

Use `HttpApiClient.make(Http.api, options)` for Effect's native grouped client.
Methods take explicit payloads containing decoded inputs and return decoded results:

```ts
const calls = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Http.api, { baseUrl: "http://localhost:3000" });
  yield* client.users.double({ payload: { value: 21 } });
  return yield* client.public.status({ payload: {} });
});
```

There is no flat client or omitted-input normalization. Pass `{ payload: {} }` for
no-input and empty optional-object input; pass `null` or `undefined` explicitly only
when the codec accepts that value. Native per-call response modes are available.

Client effects retain declared errors, schema-policy errors, `SchemaError`, and native
`HttpClientError`. Local codec failures remain `SchemaError`; the schema-error policy
runs only on the server. Use `HttpApiClient.makeWith` for custom client error and
service channels.

## MCP transport

Supply `protocols` using Effect's native `McpProtocol` adapters. Effect owns
negotiation, revision rejection, and session lifecycle; the adapter forwards the
selection unchanged. Choose `[McpProtocol.v2026_07_28]` for a stateless endpoint.

`ActionMcp.layerHttp` uses the native server's single-endpoint Streamable HTTP transport,
not historical two-endpoint HTTP+SSE, even when an older revision is selected.

MCP cancellation uses Effect's native RPC interruption. Remote cancellation and
disconnect behavior need broader client and deployment testing.

## Native Toolkit and stdio

`ActionToolkit.make(...apps)` returns `{ toolkit, layer }`. The toolkit is Effect's
native `Toolkit`; its tool names, schemas, and handler requirements remain typed.
It selects MCP-enabled actions and uses their tool aliases and hints, but does not
wrap successes in MCP's `{ value }` envelope. Yield the toolkit to obtain its bound
handlers; `tools.handle` accepts encoded arguments and returns an Effect producing
the native result stream, with declared failures represented by native tool results. This projection is not an MCP server.

The binding layer acquires each selected implementation once. Each tool retains only
its own handler's invocation requirements, not those of sibling or disabled tools.
Build-time requirements still belong to the whole selected implementation. Supply identity at that
invocation, not when building the binding; native context capture is not a security
boundary. Provide call services around the entire `tools.handle(...).pipe(Effect.flatMap(Stream.runCollect))`
effect, not just the returned stream: the native Toolkit starts the handler
while constructing that stream. Groups with no selected tools are not built.

`ActionMcp.layerStdio(options, ...apps)` uses the same MCP wire schemas and result
conventions as HTTP, through native `Stdio`. Supply `NodeStdio.layer` in a Node host.
A stdio subprocess has no HTTP authentication middleware: the host must supply
its trusted principal and other handler services explicitly. Tool arguments never
establish identity. Keep stdout exclusively for protocol messages and send logs to
stderr. Each MCP endpoint or subprocess owns a fresh native tool registry; this is
registry isolation, not isolation of arbitrary application context.

## CLI boundaries

`ActionCli.command(app, "actionName", options)` runs an explicitly selected local action.
`ActionCli.group(app, options)` puts every action under its group command, including
actions disabled for HTTP and MCP. Each invocation acquires handlers in a scope and
releases them after the call. Domain services and authority come from the CLI host;
there is no implicit HTTP fallback.

`ActionCliClient.command(http, "groupName", "actionName", options)` and
`.group(http, "groupName", options)` select contracts retained by the HTTP binding.
There is no separately supplied group to compare or reconcile. They use Effect's
native `HttpApiClient`, expose only HTTP-enabled actions, and require the host's
`HttpClient` configuration. The optional `connection` option configures the native endpoint
client (`baseUrl`, `transformClient`, `transformResponse`).
Authentication, endpoint selection, and credential storage are not inferred from action arguments or managed by this library.

CLI input is encoded JSON input. Generated commands accept
`--input '<json>'` for the entire input, including nested objects, dictionaries,
arrays, and scalar schemas. Omitting it supplies `{}`, which still must satisfy the
action's input schema.

For explicit command syntax, supply `parameters` as a native Effect `Command.Config`
and an `input(parsed)` mapping to encoded action input. Both options are required
together. The action schema validates the mapped input before dispatch. Native
`Flag` and `Argument` definitions own names, ordering, aliases, defaults, and
optionality; action fields are never automatically turned into CLI flags.
The mapper receives the native configuration's inferred parameter types and returns
`Schema.Json`. Its exact action field shape is checked at runtime: Effect's canonical
JSON codec deliberately exposes `Json`, not a statically reconstructed wire shape.
Explicitly configured commands do not add `--input`. Group commands use the default
JSON syntax; compose individual native commands for a custom command tree.

For example, `parameters: { name: Argument.String("name") }` with
`input: ({ name }) => ({ name })` makes `name` positional. Use native
`Flag.Boolean("admin").pipe(Flag.optional)` when omission must stay distinct from
`false`, and map its `Option` into an omitted or present action field.

Both CLIs decode input before dispatch. Remote calls then use the native client's
normal codec boundary; do not manually pass already-encoded values to that client.
Successful output is validated and encoded before printing JSON. An optional `render`
receives the decoded success value for human output; `--json` selects JSON instead.
Rendering cannot bypass output validation. A payload field named `json` is ordinary
action data. Explicit native flag names must not collide with the renderer's
`--json` switch; config property names can differ from flag names.

## Offline catalog

`ActionCatalog.make(...groups)` needs contracts only, not implementations, services,
or a server. Each entry has a stable `<group>.<action>` identity, description,
transport metadata, and standalone JSON schemas for input, success, and declared
errors. HTTP schema-policy errors are listed separately from domain errors. Each
schema owns its `$defs`, so equal schema identifiers in different entries cannot
silently replace each other. Recursive references stay local to their schema.

Catalogs include local-only actions. Presence in a catalog is descriptive metadata,
not authorization, tool publication, or proof that a route has been mounted. This
package does not add search, a catalog HTTP endpoint, or generated TypeScript types.
