# ActionMcp

MCP tools from implementations, on Effect's native `McpServer`. One `Tool` per served action,
named after it. Two transports: a Streamable HTTP endpoint mounted on the router, or newline-delimited
JSON-RPC on standard I/O for a subprocess. HTTP speaks MCP 2026-07-28 only; stdio also speaks
2025-11-25 and 2025-06-18, as the host negotiates.

## API

Import `@gjermundgaraba/effect-actions/ActionMcp`.

| API                         | Purpose                                                 |
| --------------------------- | ------------------------------------------------------- |
| `layerHttp(apps, options)`  | Serve implementations at a Streamable HTTP endpoint.    |
| `layerStdio(apps, options)` | Serve implementations over a subprocess's standard I/O. |

The options, exported as `HttpOptions` and `StdioOptions`, are the native
`McpServer.layerHttp` / `McpServer.layerStdio` options, except `protocols`. They pass through unchanged; `path` gains a default. Each implementation brings its
hook ([Action.md](Action.md#implementations)); authentication is middleware the host provides
around `layerHttp` ([Authentication.md](Authentication.md)).

| Option                               | Meaning                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `name`, `version`                    | Required native server information.                                            |
| `description`, `websiteUrl`, `icons` | Optional native server information, sent to clients with `name` and `version`. |
| `instructions`                       | Optional native server instructions.                                           |
| `extensions`                         | Optional native server capability extensions.                                  |
| `path`                               | HTTP endpoint path; HTTP only, defaults to `/mcp`.                             |
| `allowedOrigins`                     | Optional exact Origin allowlist; HTTP only, not CORS configuration.            |

`apps` is one implementation or a list. Every tool declares its action's errors plus the
built-in `Unauthenticated` and `Forbidden`. Both layers retain the build failures and
requirements of their builders, plus native
`IllegalArgumentError`. HTTP needs the router and wraps handler and hook services as request
requirements until middleware provided around it, such as authentication, provides them. stdio
needs `Stdio` and the caller's request services, identity included. Native `McpRequestContext`
is supplied by the server, not required of the host.

## Canonical

```ts
import { Layer } from "effect";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { authenticate } from "./authentication.js";
import { double, listChanges, status, userActions } from "./handlers.js";

const allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];

// An MCP endpoint is one route, so authentication covers all of its tools: a public
// tool gets an endpoint of its own.
const publicMcp = ActionMcp.layerHttp(status, {
  name: "effect-actions-public",
  version: "0.0.0",
  path: "/mcp/public",
  allowedOrigins,
});

// A list of implementations serves all of their actions. `path` defaults to `/mcp`.
const mcp = ActionMcp.layerHttp([userActions, double, listChanges], {
  name: "effect-actions",
  version: "0.0.0",
  allowedOrigins,
}).pipe(Layer.provide(authenticate));

export const layer = Layer.mergeAll(publicMcp, mcp);
```

### Cross-origin browsers

`allowedOrigins` alone does not configure CORS. For a stateless browser endpoint, mount
native router CORS outside the route middleware. This CORS layer is global to the router;
choose its policy for every route it covers.

```ts
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Greet } from "./quickstart.js";

const allowedOrigins = ["https://ui.example.com"];

const actions = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));

const mcp = ActionMcp.layerHttp(actions, { name: "greetings", version: "1.0.0", allowedOrigins });

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
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

const Status = Action.make("status", {
  description: "Report whether the subprocess is ready.",
  success: { ready: Schema.Boolean },
  access: "read",
});

const status = Action.implement(Status, () =>
  Effect.log("status called").pipe(Effect.as({ ready: true })),
);

const layer = ActionMcp.layerStdio(status, {
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

- HTTP serves MCP 2026-07-28 and no other revision: it is stateless, every request standing alone. The stateful revisions keep a session per `initialize`, which Effect's HTTP runtime never expires and which no identity owns. Stdio serves 2026-07-28, 2025-11-25 and 2025-06-18, whichever the host negotiates. There is no `protocols` option; Effect owns version checks and negotiation.
- Earlier revisions are refused on both transports: they have no `structuredContent`, so a success would lose its shape. Over stdio, invalid arguments are a tool error from 2025-11-25 on, and a JSON-RPC error on 2025-06-18, as that revision specifies.
- `path` defaults to `/mcp`. `layerHttp` uses the single-endpoint Streamable HTTP transport, never the two-endpoint HTTP+SSE form.
- Requests reaching the native MCP handler with an `Origin` header receive **403** unless that exact origin is listed in `allowedOrigins`. Requests without `Origin` pass this check. Authentication wrapping the endpoint runs first and may reject the request before native Origin validation; the allowlist does not protect authentication from untrusted-origin requests.
- `allowedOrigins` is an Origin allowlist, not CORS configuration. Cross-origin browser clients also need outer CORS middleware or a proxy to handle preflight and add response headers. Without it, an allowed-origin `OPTIONS` request receives **405** and even a successful `POST` has no `Access-Control-Allow-Origin`. Keep preflight outside authentication and apply CORS headers to refusals too.
- An endpoint is one route, so middleware provided around `layerHttp`, authentication included, covers every request to it, tool listing included, and every tool it serves, public ones too. To serve tools under different authentication or middleware, or without any, mount them on different paths with separate `layerHttp` calls.
- Every action of the implementations passed becomes a tool, named after the action, with the action's `hints`. To keep an action off MCP, leave its implementation out ([Action.md](Action.md#contracts)).
- Builders, the hook and request services follow [guarantees.md](guarantees.md#dependency-lifetimes). Only the tool registry is fresh per endpoint.
- Every served action must have object-root input; the native server refuses anything else when the layer is built. Omit `input`, or give `{}`, for a tool with no arguments.
- Success is `structuredContent: { value: <encoded success> }`. A declared error is an `isError` result whose text content is the error's JSON encoding, the same bytes HTTP sends as the body, and no `structuredContent`.
- Invalid arguments are answered by the native `McpServer`: an `isError` result with a message for the model, such as `Invalid parameters for tool 'greet': Expected string\n  at ["name"]`. HTTP's `InvalidInput` does not apply.
- Defects and encoding failures produce the generic `isError` text `Tool execution failed due to an internal server error.`; the cause is logged, not sent.
- Tool discovery is not filtered by actor. Every caller sees every tool of the endpoint. Authorization happens in each implementation's `before`.
- Cancellation is Effect's native RPC interruption. Over HTTP there is no session, so `notifications/cancelled` interrupts nothing; a tool call ends with its HTTP request, whose lifetime (for example, whether a client disconnect interrupts it) is the host's.
- Handlers may yield `McpSchema.McpRequestContext` for the client's declared information; the native server supplies it to every tool call, so it is never a router or host requirement.
- stdio: the host supplies `Stdio` (`NodeStdio.layer`) and any request-time services explicitly, including the trusted principal. Each implementation's `before` runs. Tool arguments never establish identity. Keep stdout for protocol messages only and route logs to stderr.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates tool names, not application context.
- `Unauthenticated` and `Forbidden` join every tool's declared failures, so a `before` refusal is an `isError` result whose text is its JSON, `{"_tag":"Forbidden","message":"Not allowed."}`, exactly like an action's own error. A schema an action already declares is not repeated.
- The hook runs after the native server decodes the tool's arguments.
- Over HTTP, a step-up refusal, `Unauthenticated` or a `Forbidden` naming `scopes`, from the hook or a handler, is an HTTP 401 or 403 with the refusal's JSON instead, as MCP authorization defines: on a `Forbidden`'s `insufficient_scope` challenge an MCP client re-authorizes with those scopes and retries ([guarantees.md](guarantees.md#dependency-lifetimes)). Only while nothing of the response has been sent: once a handler's notification, such as progress, has started a 200 event stream, a later refusal is the tool's `isError` result in it. A hook runs before its handler, so its refusal is always the status.
- Authentication refuses before the MCP handler too: an HTTP 401 or 403. An MCP client reads the 401's `WWW-Authenticate` challenge and finds its authorization server through the discovery `Authentication.make` publishes for a protected resource ([Authentication.md](Authentication.md)).

## Failure modes

- Layer build dies while registering tools, with a defect whose `SchemaError` message says `Expected "object"` or `Missing key`: a served action has scalar or array input, or `Schema.Struct({})`, which accepts any value but `null`. The native server refuses them. It is not in the layer's error channel, so it cannot be caught by tag. Wrap the input in a struct, omit `input` (or give `{}`) for no arguments, or leave the action off MCP.
- An MCP client gets an `isError` refusal instead of the 401 or 403 it re-authorizes on: the handler sent a notification before refusing, so the response had already started. Refuse in the implementation's hook, before the handler runs.
- `Duplicate MCP tool: <name>` thrown at the `layerHttp` or `layerStdio` call: two implementations on one endpoint serve actions of the same name. Split the endpoint, or rename one action.
- Type error listing `HttpRouter.Request.From<"Requires", ...>`: a handler or hook yields a request service that no middleware around the endpoint provides. Provide the authentication, `Layer.provide(authenticate)`, or other middleware (`Layer.provide(middleware.layer)`) on that `layerHttp`.
- A public tool demands credentials: it shares an endpoint with authenticated ones, and the authentication covers the whole endpoint. Serve it on an endpoint of its own.
- Client reports a broken transport from a stdio subprocess: something printed to stdout. Set `Logger.LogToStderr` and remove `console.log`.
- Older MCP client cannot connect over HTTP: a request answers `400` with JSON-RPC error `-32020`. The client speaks a 2025 revision, which opens with `initialize`. Only 2026-07-28 is served over HTTP; pin the client to it (the official client: `versionNegotiation: { mode: { pin: "2026-07-28" } }`), or serve that host over stdio.
- Client disconnects right after `initialize` over stdio: it speaks a revision older than 2025-06-18, so the server counter-offered 2025-11-25, which it does not support. Upgrade the client.
- An Origin-bearing request reaches the native handler and gets an empty 403: its `Origin` is not in `allowedOrigins`. Add the exact origin only if the deployment trusts it.
- A disallowed Origin receives 401 instead: wrapping authentication rejected it before the native Origin check. Put any required pre-authentication Host/Origin policy in outer host middleware.
- Browser calls fail despite an allowed Origin: configure CORS outside authentication and the MCP handler (see the browser example above). The native allowlist alone neither handles preflight nor adds CORS response headers.
- `Object literal may only specify known properties, and 'protocols'`: the revisions are fixed. Delete the option.
- `Object literal may only specify known properties, and 'before'`: surfaces take no hook. Pass it to `Action.implement`.
