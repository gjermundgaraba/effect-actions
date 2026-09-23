# ActionMcp

MCP tools from implementations, on Effect's native `McpServer`. One `Tool` per MCP-enabled
action. Two transports: a Streamable HTTP endpoint mounted on the router, or newline-delimited
JSON-RPC on standard I/O for a subprocess. Both speak MCP 2026-07-28 only.

## API

Import `@gjermundgaraba/effect-actions/ActionMcp`.

| API                         | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `layerHttp(apps, options)`  | Serve a readonly collection of implementations at a Streamable HTTP endpoint. |
| `layerStdio(apps, options)` | Serve implementations over a subprocess's standard I/O.                       |
| `Options`, `StdioOptions`   | Configuration for the two transports.                                         |

The options are the native `McpServer.layerHttp` / `McpServer.layerStdio` options, except
`protocols`, plus this surface's `errors` and `before`. The native ones pass through unchanged.

| Option                               | Meaning                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `name`, `version`                    | Required native server information.                                                                   |
| `description`, `websiteUrl`, `icons` | Optional native server information, sent to clients with `name` and `version`.                        |
| `instructions`                       | Optional native server instructions.                                                                  |
| `extensions`                         | Optional native server capability extensions.                                                         |
| `path`                               | Required HTTP endpoint path; HTTP only, no default.                                                   |
| `allowedOrigins`                     | Optional exact Origin allowlist; HTTP only, not CORS configuration.                                   |
| `errors`                             | Optional surface error codecs, declared on every served tool.                                         |
| `before`                             | Optional Effectful hook receiving the selected `Action.Any`; fails only with declared surface errors. |

Both layers retain served implementations' build failures and requirements, plus native
`IllegalArgumentError`. HTTP needs the router and wraps handler/hook services as request
requirements. stdio needs `Stdio` and the caller's request services. Native `McpRequestContext`
is supplied by the server, not owed by the host.

## Canonical

```ts
import { Layer } from "effect";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { AuditApp, PublicApp, UserApp } from "./handlers.js";
import { authentication, authorize, Forbidden } from "./auth.js";

const allowedOrigins = ["http://localhost:3000"];

// One endpoint is one route: its middleware covers every tool on it.
// Tools with different middleware needs get their own endpoint.
const publicMcp = ActionMcp.layerHttp([PublicApp], {
  name: "app-public",
  version: "1.0.0",
  path: "/mcp/public",
  allowedOrigins,
});

const mcp = ActionMcp.layerHttp([UserApp, AuditApp], {
  name: "app",
  version: "1.0.0",
  path: "/mcp",
  allowedOrigins,
  // The same rule the HTTP binding runs, declared here so a refusal is an
  // ordinary tool failure rather than a transport error.
  errors: [Forbidden],
  before: authorize,
}).pipe(Layer.provide(authentication.layer));

export const layer = Layer.mergeAll(publicMcp, mcp);
```

### Cross-origin browsers

`allowedOrigins` alone does not configure CORS. For a stateless browser endpoint, mount
native router CORS outside the route middleware. This CORS layer is global to the router;
choose its policy for every route it covers.

```ts
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Actions } from "./quickstart.js";

const allowedOrigins = ["https://ui.example.com"];

const app = Actions.implement({ greet: ({ name }) => Effect.succeed(`Hello, ${name}!`) });

const mcp = ActionMcp.layerHttp([app], {
  name: "greetings",
  version: "1.0.0",
  path: "/mcp",
  allowedOrigins,
});

// Global router CORS handles preflight outside route-level authentication.
// This example is public; protected endpoints still need authentication and a hook.
export const routes = Layer.mergeAll(
  mcp,
  HttpRouter.cors({
    allowedOrigins,
    allowedMethods: ["POST"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "MCP-Protocol-Version",
      "MCP-Method",
      "MCP-Name",
    ],
    exposedHeaders: ["WWW-Authenticate", "MCP-Protocol-Version"],
  }),
);
```

### Subprocess

```ts
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Console, Effect, Layer, Logger, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

const Status = Action.make("status", {
  description: "Report whether the subprocess is ready.",
  success: Schema.Struct({ ready: Schema.Boolean }),
  access: "read",
});

const app = ActionGroup.make({ name: "stdio" }, Status).implement({
  status: () => Effect.log("status called").pipe(Effect.as({ ready: true })),
});

const layer = ActionMcp.layerStdio([app], {
  name: "effect-actions-stdio",
  version: "0.1.0",
}).pipe(Layer.provide(NodeStdio.layer));

// Protocol messages use stdout exclusively. Runtime diagnostics remain on stderr.
Layer.launch(layer).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

## Rules

- Both transports serve MCP 2026-07-28 and no other revision; there is no `protocols` option. Over HTTP the endpoint is stateless: no initialize handshake, no session, and every request stands alone. Effect owns version checks and rejects any other revision. Stdio has no sessions, so it could serve an older host, but it refuses one deliberately, for uniformity: a client that works over one transport works over the other.
- `path` has no default. `layerHttp` uses the single-endpoint Streamable HTTP transport, never the two-endpoint HTTP+SSE form, whatever revision is negotiated.
- Requests reaching the native MCP handler with an `Origin` header receive **403** unless that exact origin is listed in `allowedOrigins`. Requests without `Origin` pass this check. Authentication middleware wrapping the endpoint runs first and may reject the request before native Origin validation; the allowlist does not protect authentication from untrusted-origin requests.
- `allowedOrigins` is an Origin allowlist, not CORS configuration. Cross-origin browser clients also need outer CORS middleware or a proxy to handle preflight and add response headers. Without it, an allowed-origin `OPTIONS` request receives **405** and even a successful `POST` has no `Access-Control-Allow-Origin`. Keep preflight outside authentication and apply CORS headers to refusals too.
- An endpoint is one route. Middleware provided to `layerHttp` covers all of its tools. To serve tools under different middleware, mount them on different paths with separate `layerHttp` calls.
- Only MCP-enabled actions become tools, under `mcp.name` with the resolved hints. A group with no tools is not built.
- Every MCP-enabled action must have object-root input; the native server refuses anything else when the layer is built. Omit `input` for a tool with no arguments.
- Success is `structuredContent: { value: <encoded success> }`. A declared error is an `isError` result whose text content is the error's JSON encoding, the same bytes HTTP sends as the body, and no `structuredContent`.
- Invalid arguments and unencodable results are answered by the native `McpServer`: an `isError` result with a message for the model. Group `schemaError` policies do not apply.
- Defects and encoding failures produce the generic `isError` text `Tool execution failed due to an internal server error.`; the cause is logged, not sent.
- Tool discovery is not filtered by actor. Every caller sees every tool of the endpoint. Authorization happens in `before`.
- Cancellation is Effect's native RPC interruption. Over HTTP there is no session, so `notifications/cancelled` interrupts nothing; a tool call ends with its HTTP request, whose lifetime (for example, whether a client disconnect interrupts it) is the host's.
- Handlers may yield `McpSchema.McpRequestContext` for the client's declared information; the native server supplies it to every tool call, so it is never a router or host requirement.
- stdio: the host supplies `Stdio` (`NodeStdio.layer`) and any request-time services explicitly, including the trusted principal. There is no authentication middleware. Tool arguments never establish identity. Keep stdout for protocol messages only and route logs to stderr.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates tool names, not application context.
- `errors` are the failures this transport answers with rather than a handler. They join every tool's declared failures, so a refusal is returned exactly like an action's own error and no caller sees a protocol-level error instead. A schema an action already declares is not repeated.
- `before` runs after successful native argument decoding and before the selected handler, with its action contract. Invalid arguments skip the hook and handler. A hook failure prevents the handler from running; its services join handler request requirements.

## Failure modes

- Layer build dies while registering tools, with a defect whose `SchemaError` message says `Expected "object"` or `Missing key`: an MCP-enabled action has scalar, array, or empty-struct input, which the native server refuses. It is not in the layer's error channel, so it cannot be caught by tag. Wrap the input in a struct with at least one field, omit `input` for no arguments, or set `mcp: false`.
- `Duplicate MCP tool: <name>` thrown at the `layerHttp` or `layerStdio` call: two apps on one endpoint expose the same tool name. Rename with `mcp.name` or split the endpoint.
- Type error listing `HttpRouter.Request.From<"Requires", ...>`: a handler yields a request service and the endpoint has no middleware providing it. Provide it with `Layer.provide(middleware.layer)` on that `layerHttp`.
- Public tool requires a token: it shares an endpoint with protected tools. Give it its own path.
- Client reports a broken transport from a stdio subprocess: something printed to stdout. Set `Logger.LogToStderr` and remove `console.log`.
- Older MCP client cannot connect: over HTTP a request answers `400` with JSON-RPC error `-32020`, over stdio `initialize` answers JSON-RPC error `-32022`. The client speaks a 2025 revision, which opens with `initialize`. Only 2026-07-28 is served; pin the client to it (the official client: `versionNegotiation: { mode: { pin: "2026-07-28" } }`).
- An Origin-bearing request reaches the native handler and gets an empty 403: its `Origin` is not in `allowedOrigins`. Add the exact origin only if the deployment trusts it.
- A disallowed Origin receives 401 instead: wrapping authentication rejected it before the native Origin check. Put any required pre-authentication Host/Origin policy in outer host middleware.
- Browser calls fail despite an allowed Origin: configure CORS outside authentication and the MCP handler (see the browser example above). The native allowlist alone neither handles preflight nor adds CORS response headers.
- `Object literal may only specify known properties, and 'protocols'`: the revision is fixed. Delete the option.
- A refusal arrives as a generic internal-error result: the hook failed with an error this transport does not declare, which is a defect. Add its schema to `errors`.
