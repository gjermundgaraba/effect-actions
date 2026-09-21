# ActionMcp

MCP tools from implementations, on Effect's native `McpServer`. One `Tool` per MCP-enabled
action. Two transports: a Streamable HTTP endpoint mounted on the router, or newline-delimited
JSON-RPC on standard I/O for a subprocess.

## API

```ts
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

function layerHttp<const Apps extends ReadonlyArray<AnyImplementation>>(
  options: Options,
  ...apps: Apps
): Layer.Layer<
  never,
  BuildError<Apps[number]> | Cause.IllegalArgumentError,
  | BuildContext<Apps[number]>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", RequestContext<Apps[number]>>
>;

function layerStdio<const Apps extends ReadonlyArray<AnyImplementation>>(
  options: StdioOptions,
  ...apps: Apps
): Layer.Layer<
  never,
  BuildError<Apps[number]> | Cause.IllegalArgumentError,
  BuildContext<Apps[number]> | Stdio | RequestContext<Apps[number]>
>;

interface Options {
  readonly name: string; // server info
  readonly version: string;
  readonly protocols: ReadonlyArray<McpProtocol>; // required, e.g. [McpProtocol.v2026_07_28]
  readonly path: HttpRouter.PathInput; // no default
  readonly allowedOrigins?: ReadonlyArray<string>; // passed to McpServer.layerHttp
  readonly instructions?: string;
}

interface StdioOptions {
  readonly name: string;
  readonly version: string;
  readonly protocols: ReadonlyArray<McpProtocol>;
  readonly instructions?: string;
}
```

## Canonical

```ts
import { Layer } from "effect";
import { McpProtocol } from "effect/unstable/ai";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { AuditApp, PublicApp, UserApp } from "./handlers.js";
import { authentication } from "./auth.js";

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
  },
  UserApp,
  AuditApp,
).pipe(Layer.provide(authentication.layer));

export const layer = Layer.mergeAll(publicMcp, mcp);
```

Subprocess:

```ts
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Console, Effect, Layer, Logger } from "effect";
import { McpProtocol } from "effect/unstable/ai";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

const layer = ActionMcp.layerStdio(
  { name: "app-stdio", version: "1.0.0", protocols: [McpProtocol.v2026_07_28] },
  app,
).pipe(Layer.provide(NodeStdio.layer));

// stdout is protocol-only; logs go to stderr.
Layer.launch(layer).pipe(
  Effect.tapCause((cause) => Console.error(cause)),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

## Rules

- `protocols` is required and takes Effect's native `McpProtocol` adapters. Effect owns negotiation, revision rejection, and sessions. `[McpProtocol.v2026_07_28]` gives a stateless endpoint that needs no initialize handshake.
- `path` has no default. `layerHttp` uses the single-endpoint Streamable HTTP transport, never the two-endpoint HTTP+SSE form, whatever revision is negotiated.
- An endpoint is one route. Middleware provided to `layerHttp` covers all of its tools. To serve tools under different middleware, mount them on different paths with separate `layerHttp` calls.
- Only MCP-enabled actions become tools, under `mcp.name` with the resolved hints. A group with no tools is not built.
- Every MCP-enabled action must have object-root input. Checked synchronously when `layerHttp` or `layerStdio` is called, before any handler is acquired; a violation throws. The `IllegalArgumentError` in the layer's error channel comes from the native transport, not from this check.
- Success is `structuredContent: { value: <encoded success> }`. A declared error is an `isError` result whose text content is the error's JSON encoding, the same bytes HTTP sends as the body, and no `structuredContent`.
- Invalid arguments and unencodable results are answered by the native `McpServer`: an `isError` result with a message for the model. Group `schemaError` policies do not apply.
- Defects and encoding failures produce the generic `isError` text `Tool execution failed due to an internal server error.`; the cause is logged, not sent.
- Tool discovery is not filtered by actor. Every caller sees every tool of the endpoint. Authorization happens in the handler.
- Cancellation is Effect's native RPC interruption.
- Handlers may yield `McpSchema.McpRequestContext` for the client's declared information; the native server supplies it to every tool call, so it is never a router or host requirement.
- stdio: the host supplies `Stdio` (`NodeStdio.layer`) and any request-time services explicitly, including the trusted principal. There is no authentication middleware. Tool arguments never establish identity. Keep stdout for protocol messages only and route logs to stderr.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates tool names, not application context.

- The group's pre-handler hook runs before every tool call. A refusal is the tool's declared failure: an `isError` result whose text is the error's JSON encoding, exactly as for a handler failure.

## Failure modes

- `<action>: MCP input must have an object root; omit input for no arguments` thrown at the `layerHttp` or `layerStdio` call: the action has scalar or array input. Wrap it in a struct or set `mcp: false`.
- `Duplicate MCP tool: <name>` thrown at the `layerHttp` or `layerStdio` call: two apps on one endpoint expose the same tool name. Rename with `mcp.name` or split the endpoint.
- Type error listing `HttpRouter.Request.From<"Requires", ...>`: a handler yields a request service and the endpoint has no middleware providing it. Provide it with `Layer.provide(middleware.layer)` on that `layerHttp`.
- Public tool requires a token: it shares an endpoint with protected tools. Give it its own path.
- Client reports a broken transport from a stdio subprocess: something printed to stdout. Set `Logger.LogToStderr` and remove `console.log`.
- Older MCP client cannot connect: the client expects a revision not listed in `protocols`. Add the adapter for that revision.
