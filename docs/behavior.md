# Adapter behavior

## Dependency lifetimes

`ActionGroup.implement` takes a complete handler record or an Effect producing one.
Handlers receive decoded input, return decoded results, and may fail only with
the errors declared by their action.

Services yielded in the builder Effect are resolved at Layer construction. Both
adapters share that acquisition once per runtime; scoped resources are released
when the runtime closes. Each `implement` call owns a separate binding. The
implementation exposes no public handler service or Layer; provide domain-service
Layers to the adapters instead.

Services yielded inside a handler are request requirements, represented by
`HttpRouter.Request.From<"Requires", R>`. Supply them through router middleware,
`HttpRouter.provideRequest`, or the request context. A startup Layer providing the
same service does not satisfy a request requirement, either in types or at runtime.
See the [authenticated example](../examples/README.md) for this separation.

The application remains responsible for establishing identity and checking
permissions. Types verify that a required service is present, not that its value
is trustworthy or that a handler performed authorization.

## Schema-error policies

By default, HTTP retains Effect's native empty 400 for decoding/encoding failures;
MCP retains native invalid-argument handling and treats output-encoding failures
as defects. Applications can supply the **same policy to both adapters**:

```ts
import { Layer, Schema } from "effect";
import { Action, ActionHttp, ActionMcp } from "@gjermundgaraba/effect-actions";
import { Actions } from "./examples/contracts.js";
import { App } from "./examples/handlers.js";

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

const schemaError = Action.schemaErrorPolicy({
  errors: [BadRequest, InternalServerError],
  map: ({ phase }) =>
    phase === "output"
      ? new InternalServerError({ error: "Request could not be completed" })
      : new BadRequest({ error: "Invalid request" }),
});

const Http = ActionHttp.make(Actions, { apiPath: "/api/actions", schemaError });
const routes = Layer.mergeAll(
  Http.layer(App, { openapiPath: "/openapi.json" }),
  ActionMcp.layer(App, { name: "my-app", version: "0", path: "/mcp", schemaError }),
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

Object schemas strip excess fields unless configured to reject them. Effect generates
OpenAPI component names, references, and operation IDs (`<group>.<action>`).

## HTTP client details

Methods take decoded inputs and return decoded results. They retain declared
errors, schema-policy errors, `SchemaError`, and native `HttpClientError`.
Local client codec failures remain `SchemaError`; the schema-error policy runs
only on the server.

An argument is optional when the input type accepts `{}`. Omitted input and
explicit `undefined` send `{}` unless the decoded input schema accepts
`undefined` as a value. `null` passes through unchanged.

Use `HttpApiClient.make(Http.api, options)` for grouped methods
such as `client.users.double({ payload: { value: 21 } })` and per-call response
modes. Use `makeWith` for custom client error and service channels. Actions named
`then` require this grouped client to avoid JavaScript thenable assimilation.

## MCP transport

`ActionMcp.protocols` lists the revisions enabled by default: 2026-07-28,
2025-11-25, 2025-06-18, 2025-03-26, and 2024-11-05. Override `protocols` to select
a subset. All use the native server's single-endpoint Streamable HTTP transport;
this does not implement the historical two-endpoint HTTP+SSE transport.

The 2026-07-28 revision is stateless; older revisions initialize a session.
MCP cancellation uses Effect's native RPC interruption. Remote cancellation and
disconnect behavior need broader client and deployment testing.
