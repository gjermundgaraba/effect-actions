# ActionMcp

MCP tools from implementations, on Effect's native `McpServer`. One `Tool` per MCP-enabled
action. Two transports: a Streamable HTTP endpoint mounted on the router, or newline-delimited
JSON-RPC on standard I/O for a subprocess.

## API

```ts
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

function layerHttp<const Apps extends ReadonlyArray<AnyImplementation>, Errors = [], RB = never>(
  options: Options<Errors, RB>,
  ...apps: Apps
): Layer.Layer<
  never,
  BuildError<Apps[number]> | Cause.IllegalArgumentError,
  | BuildContext<Apps[number]>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", RequestContext<Apps[number]> | RB>
>;

function layerStdio<const Apps extends ReadonlyArray<AnyImplementation>, Errors = [], RB = never>(
  options: StdioOptions<Errors, RB>,
  ...apps: Apps
): Layer.Layer<
  never,
  BuildError<Apps[number]> | Cause.IllegalArgumentError,
  BuildContext<Apps[number]> | Stdio | RequestContext<Apps[number]> | RB
>;

/** Both transports share these. */
interface SurfaceOptions<Errors, RB> {
  readonly errors?: Errors; // declared on every tool of this transport
  readonly before?: (action: Action.Any) => Effect.Effect<void, Errors[number]["Type"], RB>;
}

interface Options<Errors = [], RB = never> extends SurfaceOptions<Errors, RB> {
  readonly name: string; // server info
  readonly version: string;
  readonly protocols: NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>; // required, e.g. [McpProtocol.v2026_07_28]
  readonly path: HttpRouter.PathInput; // no default
  readonly allowedOrigins?: ReadonlyArray<string>; // passed to McpServer.layerHttp
  readonly instructions?: string;
}

interface StdioOptions<Errors = [], RB = never> extends SurfaceOptions<Errors, RB> {
  readonly name: string;
  readonly version: string;
  readonly protocols: NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>;
  readonly instructions?: string;
}
```

## Canonical

```ts
import { Layer } from "effect";
import { McpProtocol } from "effect/unstable/ai";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { AuditApp, PublicApp, UserApp } from "./handlers.js";
import { authentication, authorize, Forbidden } from "./auth.js";

const allowedOrigins = ["http://localhost:3000"];

// One endpoint is one route: its middleware covers every tool on it.
// Tools with different middleware needs get their own endpoint.
const publicMcp = ActionMcp.layerHttp(
  {
    protocols: [McpProtocol.v2026_07_28],
    name: "app-public",
    version: "1.0.0",
    path: "/mcp/public",
    allowedOrigins,
  },
  PublicApp,
);

const mcp = ActionMcp.layerHttp(
  {
    protocols: [McpProtocol.v2026_07_28],
    name: "app",
    version: "1.0.0",
    path: "/mcp",
    allowedOrigins,
    // The same rule the HTTP binding runs, declared here so a refusal is an
    // ordinary tool failure rather than a transport error.
    errors: [Forbidden],
    before: authorize,
  },
  UserApp,
  AuditApp,
).pipe(Layer.provide(authentication.layer));

export const layer = Layer.mergeAll(publicMcp, mcp);
```

### Cross-origin browsers

`allowedOrigins` alone does not configure CORS. For a stateless browser endpoint, mount
native router CORS outside the route middleware. This CORS layer is global to the router;
choose its policy for every route it covers.

```ts
import { Effect, Layer } from "effect";
import { McpProtocol } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Actions } from "./quickstart.js";

const allowedOrigins = ["https://ui.example.com"];

const app = Actions.implement({ greet: ({ name }) => Effect.succeed(`Hello, ${name}!`) });

const mcp = ActionMcp.layerHttp(
  {
    name: "greetings",
    version: "1.0.0",
    path: "/mcp",
    protocols: [McpProtocol.v2026_07_28],
    allowedOrigins,
  },
  app,
);

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
import { McpProtocol } from "effect/unstable/ai";
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

const layer = ActionMcp.layerStdio(
  { name: "effect-actions-stdio", version: "0.1.0", protocols: [McpProtocol.v2026_07_28] },
  app,
).pipe(Layer.provide(NodeStdio.layer));

// Protocol messages use stdout exclusively. Runtime diagnostics remain on stderr.
Layer.launch(layer).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

## Rules

- `protocols` is required and must be a nonempty list of Effect's native `McpProtocol.ProtocolAdapter` values. Effect owns negotiation, revision rejection, and sessions. `[McpProtocol.v2026_07_28]` gives a stateless endpoint that needs no initialize handshake.
- `path` has no default. `layerHttp` uses the single-endpoint Streamable HTTP transport, never the two-endpoint HTTP+SSE form, whatever revision is negotiated.
- Requests reaching the native MCP handler with an `Origin` header receive **403** unless that exact origin is listed in `allowedOrigins`. Requests without `Origin` pass this check. Authentication middleware wrapping the endpoint runs first and may reject the request before native Origin validation; the allowlist does not protect authentication from untrusted-origin requests.
- `allowedOrigins` is an Origin allowlist, not CORS configuration. Cross-origin browser clients also need outer CORS middleware or a proxy to handle preflight and add response headers. Without it, an allowed-origin `OPTIONS` request receives **405** and even a successful `POST` has no `Access-Control-Allow-Origin`. Keep preflight outside authentication and apply CORS headers to refusals too.
- An endpoint is one route. Middleware provided to `layerHttp` covers all of its tools. To serve tools under different middleware, mount them on different paths with separate `layerHttp` calls.
- Only MCP-enabled actions become tools, under `mcp.name` with the resolved hints. A group with no tools is not built.
- Every MCP-enabled action must have object-root input. Checked synchronously when `layerHttp` or `layerStdio` is called, before any handler is acquired; a violation throws. The `IllegalArgumentError` in the layer's error channel comes from the native transport, not from this check.
- Success is `structuredContent: { value: <encoded success> }`. A declared error is an `isError` result whose text content is the error's JSON encoding, the same bytes HTTP sends as the body, and no `structuredContent`.
- Invalid arguments and unencodable results are answered by the native `McpServer`: an `isError` result with a message for the model. Group `schemaError` policies do not apply.
- Defects and encoding failures produce the generic `isError` text `Tool execution failed due to an internal server error.`; the cause is logged, not sent.
- Tool discovery is not filtered by actor. Every caller sees every tool of the endpoint. Authorization happens in `before`.
- Cancellation is Effect's native RPC interruption.
- Handlers may yield `McpSchema.McpRequestContext` for the client's declared information; the native server supplies it to every tool call, so it is never a router or host requirement.
- stdio: the host supplies `Stdio` (`NodeStdio.layer`) and any request-time services explicitly, including the trusted principal. There is no authentication middleware. Tool arguments never establish identity. Keep stdout for protocol messages only and route logs to stderr.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates tool names, not application context.
- `errors` are the failures this transport answers with rather than a handler. They join every tool's declared failures, so a refusal is returned exactly like an action's own error and no caller sees a protocol-level error instead. A schema an action already declares is not repeated.
- `before` runs once per tool call, with the selected action contract, before the handler. The native server decodes the tool arguments first, so unlike HTTP the hook runs after input decoding; it still runs on every call and the handler never runs when it fails. Its services are request-time requirements, joined with the handlers'.

## Failure modes

- `<action>: MCP input must have an object root; omit input for no arguments` thrown at the `layerHttp` or `layerStdio` call: the action has scalar or array input. Wrap it in a struct or set `mcp: false`.
- `Duplicate MCP tool: <name>` thrown at the `layerHttp` or `layerStdio` call: two apps on one endpoint expose the same tool name. Rename with `mcp.name` or split the endpoint.
- Type error listing `HttpRouter.Request.From<"Requires", ...>`: a handler yields a request service and the endpoint has no middleware providing it. Provide it with `Layer.provide(middleware.layer)` on that `layerHttp`.
- Public tool requires a token: it shares an endpoint with protected tools. Give it its own path.
- Client reports a broken transport from a stdio subprocess: something printed to stdout. Set `Logger.LogToStderr` and remove `console.log`.
- Older MCP client cannot connect: the client expects a revision not listed in `protocols`. Add the adapter for that revision.
- An Origin-bearing request reaches the native handler and gets an empty 403: its `Origin` is not in `allowedOrigins`. Add the exact origin only if the deployment trusts it.
- A disallowed Origin receives 401 instead: wrapping authentication rejected it before the native Origin check. Put any required pre-authentication Host/Origin policy in outer host middleware.
- Browser calls fail despite an allowed Origin: configure CORS outside authentication and the MCP handler (see the browser example above). The native allowlist alone neither handles preflight nor adds CORS response headers.
- Type error on an empty `protocols` array: provide at least one native protocol adapter.
- A refusal arrives as a generic internal-error result: the hook failed with an error this transport does not declare, which is a defect. Add its schema to `errors`.
