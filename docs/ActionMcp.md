# ActionMcp

MCP tools from implementations, on Effect's native `McpServer`. One `Tool` per served action,
named after it. Two transports: a Streamable HTTP endpoint mounted on the router, or newline-delimited
JSON-RPC on standard I/O for a subprocess. HTTP speaks MCP 2026-07-28 only; stdio also speaks
2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, as the host negotiates.

## API

Import `@gjermundgaraba/effect-actions/ActionMcp`.

| API                                   | Purpose                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `layerHttp(implementations, options)` | Serve implementations at a Streamable HTTP endpoint.                                               |
| `runStdio(implementations, options)`  | Serve implementations as a subprocess's program on standard I/O; succeeds when the host closes it. |

The options, exported as `LayerHttpOptions` and `Options` (the server's, which `LayerHttpOptions` extends), are the native
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

`implementations` is one implementation or a list. Every tool declares its action's errors plus the
built-in `InvalidInput`, `Unauthenticated` and `Forbidden`. Both layers retain the build failures and
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
import { HttpRouter } from "effect/http";
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
import { Cause, Console, Effect, Logger, Runtime, Schema } from "effect";
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

// Serves until the host closes stdin, then exits 0. Protocol messages use stdout
// exclusively: runStdio sends its own Effect logs to stderr, and `LogToStderr` those of
// the services provided around it.
ActionMcp.runStdio(status, { name: "effect-actions-stdio", version: "0.1.0" }).pipe(
  Effect.provide(NodeStdio.layer),
  // Report a failure as runMain would, but on stderr.
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause))
      ? Effect.void
      : Console.error(Cause.pretty(cause)),
  ),
  // Outermost, so every layer provided above it logs to stderr too.
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

## Rules

- HTTP serves MCP 2026-07-28 and no other revision: it is stateless, every request standing alone. The stateful revisions keep a session per `initialize`, which Effect's HTTP runtime never expires and which no identity owns. Stdio serves 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, whichever the host negotiates. There is no `protocols` option; Effect owns version checks and negotiation.
- `path` defaults to `/mcp`. `layerHttp` uses the single-endpoint Streamable HTTP transport, never the two-endpoint HTTP+SSE form.
- Requests reaching the native MCP handler with an `Origin` header receive **403** unless that exact origin is listed in `allowedOrigins`. Requests without `Origin` pass this check. Authentication wrapping the endpoint runs first and may reject the request before native Origin validation; the allowlist does not protect authentication from untrusted-origin requests.
- `allowedOrigins` is an Origin allowlist, not CORS configuration. Cross-origin browser clients also need outer CORS middleware or a proxy to handle preflight and add response headers. Without it, an allowed-origin `OPTIONS` request receives **405** and even a successful `POST` has no `Access-Control-Allow-Origin`. Keep preflight outside authentication and apply CORS headers to refusals too.
- An endpoint is one route, so middleware provided around `layerHttp`, authentication included, covers every request to it, tool listing included, and every tool it serves, public ones too. To serve tools under different authentication or middleware, or without any, mount them on different paths with separate `layerHttp` calls.
- Every action of the implementations passed becomes a tool, named after the action, with the action's `hints` (except on stdio revision 2024-11-05, which has no tool hints). To keep an action off MCP, leave its implementation out ([Action.md](Action.md#contracts)).
- Builders and request services follow the [dependency lifetimes](guarantees.md#dependency-lifetimes), and the hook the [authorization rules](guarantees.md#authorization). Only the tool registry is fresh per endpoint.
- Every served action's input must be one object with keys, as a tool's arguments are: fields, a struct or a class, identified or recursive, or a record. `layerHttp` and `runStdio` refuse any other with a type error naming the actions: a union, an array, a scalar, or an object without keys such as `Schema.Struct({})`. Input the types do not check, the native server refuses when the layer is built: erased input, and a helper's own type parameter, passed alone or spread into a list (`layerHttp([...apps, status], options)`). An argument chosen by a condition, `debug ? [status, inspect] : [status]`, compiles when one choice's input passes: the native server refuses another's when the layer is built. When no choice's input passes, it is a type error. Omit `input`, or give `{}`, for a tool with no arguments.
- Success has text content encoding `{ value: <encoded success> }` on every revision, repeated as `structuredContent` from 2025-06-18 on. Earlier stdio revisions have no `structuredContent`. A declared error is an `isError` result whose text content is the error's JSON encoding, the same bytes HTTP sends as the body, and no `structuredContent`.
- Invalid arguments are answered by the native `McpServer`: from 2025-11-25 on, an `isError` result with a message for the model, such as `Invalid parameters for tool 'greet': Expected string\n  at ["name"]`; on earlier stdio revisions, a JSON-RPC error. HTTP's `InvalidInput` does not apply.
- Defects and encoding failures produce the generic `isError` text `Tool execution failed due to an internal server error.`; the cause is logged, not sent.
- Every caller sees every tool of the endpoint ([guarantees.md](guarantees.md#scope)); authorization happens in each implementation's `before`.
- Cancellation is Effect's native RPC interruption. Over HTTP there is no session, so `notifications/cancelled` interrupts nothing. A tool call ends with its HTTP request, whose lifetime (for example, whether a client disconnect interrupts it) is the host's.
- Handlers may yield `McpSchema.McpRequestContext` for the client's declared information; the native server supplies it to every tool call, so it is never a router or host requirement.
- `runStdio` is the subprocess's whole program: it serves until the host closes stdin, then succeeds, so the process exits 0. A signal interrupts it, as any program. Provide `Stdio` and its services to it and run it, `NodeRuntime.runMain`.
- stdio: the host supplies `Stdio` (`NodeStdio.layer`) and any request-time services explicitly, including the trusted principal. Each implementation's `before` runs. Tool arguments never establish identity.
- `runStdio` gives its program a `Console` that writes every method to stderr, since stdout carries the protocol: every console logger, the default one included, `Console.log`, and the counters, timers and group labels Node's console prints on stdout. It counts, times and warns with the labels of Node's console, and a group indents every line of a string first argument and the first line of a value it inspects. A timer prints seconds past a minute, `dir` takes no inspect options, `table` prints its data without a grid or column filter, and `clear` does nothing. For layers provided around `runStdio`, provide `Logger.LogToStderr` outermost, as the example does. Keep the global `console.log` and other direct writes off stdout.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates tool names, not application context.
- Every tool declares the built-in errors ([guarantees.md](guarantees.md#wire-behavior)). A `before` refusal is an `isError` result whose text is its JSON, `{"_tag":"Forbidden","message":"Not allowed."}`, exactly like an action's own error.
- The hook runs after the native server decodes the tool's arguments.
- Under `Authentication.make`, a step-up refusal is an HTTP 401 or 403 instead of a tool result ([guarantees.md](guarantees.md#authorization)); without it, a tool result. On a `Forbidden`'s `insufficient_scope` challenge, an MCP client re-authorizes with those scopes and retries.
- That holds only while nothing of the response has been sent. Once a handler's notification, such as progress, has started a 200 event stream, a later refusal is the tool's `isError` result in it. A hook runs before its handler, so its refusal is always the status.
- Authentication refuses before the MCP handler too: an HTTP 401 or 403. An MCP client reads the 401's `WWW-Authenticate` challenge and finds its authorization server through the discovery `Authentication.make` publishes for a protected resource ([Authentication.md](Authentication.md)).

## Failure modes

- Type error `Property '"MCP tool input must be one object with keys, such as a struct"' is missing` at `layerHttp` or `runStdio`, naming actions: their input is a union, an array, a scalar, or an object without keys such as `Schema.Struct({})`. Wrap a union in a field, `input: { notification: Schema.Union([Email, Sms]) }`, omit `input` (or give `{}`) for no arguments, or leave the action off MCP.
- A type error inside a helper, at `layerHttp` or `runStdio`, naming `McpInputs` or `NotObjectInput` rather than an action: the helper lists an implementation typed by its type parameter (`[app, status]`), or is generic over actions (`Action.AnyImplementation<A>`), so the rule cannot read the input. Pass the type parameter alone, or take the implementations as one, `<const Apps extends ReadonlyArray<Action.AnyImplementation>>(apps: Apps)`, and spread it, `layerHttp([...apps, status], options)`.
- A type error at `layerHttp` or `runStdio` ending `Type '"<name>"' is not assignable to type '"<name>"'`, comparing two actions rather than naming the rule: the argument is chosen by a condition, `debug ? [inspect] : [trace]`, and no choice's input is one object with keys. Correct each choice's input, or build one list whose elements the condition chooses, `[status, ...(debug ? [inspect] : [])]`, whose type error names the actions.
- Layer build dies while registering tools, with a defect `McpServer cannot register tool '<name>'`: the types did not check that input, because it is erased, one choice of an argument chosen by a condition, passed through a helper's type parameter, or unusual, such as `Schema.Unknown`, a `Schema.Date` root or a union of one member. The defect is not in the layer's error channel, so it cannot be caught by tag. Fix the input as above; for no arguments omit `input`, rather than use the `Tool.EmptyParams` the message suggests.
- A native `McpServer.resource`, `McpServer.prompt` or `McpServer.toolkit` layer merged beside `layerHttp` builds without error and is never served: `resources/list` is empty, `prompts/list` is not found, and `tools/list` lists only the actions. Each endpoint's registry is its own, and only its actions register on it. Serve native features from a native `McpServer.layerHttp` endpoint on another path.
- An MCP client gets an `isError` refusal instead of the 401 or 403 it re-authorizes on: the handler sent a notification before refusing, so the response had already started. Refuse in the implementation's hook, before the handler runs.
- `Duplicate MCP tool: <name>` thrown at the `layerHttp` or `runStdio` call: two implementations on one endpoint serve actions of the same name. Split the endpoint, or rename one action.
- Type error listing `HttpRouter.Request.From<"Requires", ...>`: a handler or hook yields a request service that no middleware around the endpoint provides. Provide the authentication, `Layer.provide(authenticate)`, or other middleware (`Layer.provide(middleware.layer)`) on that `layerHttp`.
- A public tool demands credentials: it shares an endpoint with authenticated ones, and the authentication covers the whole endpoint. Serve it on an endpoint of its own.
- Client reports a broken transport from a stdio subprocess: something wrote to stdout, such as `console.log`, or a layer provided around `runStdio` without `Logger.LogToStderr` outermost. Remove the write, or provide it.
- Older MCP client cannot connect over HTTP: a request answers `400` with JSON-RPC error `-32020`. The client speaks a 2025 revision, which opens with `initialize`. Only 2026-07-28 is served over HTTP; pin the client to it (the official client: `versionNegotiation: { mode: { pin: "2026-07-28" } }`), or serve that host over stdio.
- An Origin-bearing request reaches the native handler and gets an empty 403: its `Origin` is not in `allowedOrigins`. Add the exact origin only if the deployment trusts it.
- A disallowed Origin receives 401 instead: wrapping authentication rejected it before the native Origin check. Put any required pre-authentication Host/Origin policy in outer host middleware.
- Browser calls fail despite an allowed Origin: configure CORS outside authentication and the MCP handler (see the browser example above). The native allowlist alone neither handles preflight nor adds CORS response headers.
- `Object literal may only specify known properties, and 'protocols'`: the revisions are fixed. Delete the option.
- `Object literal may only specify known properties, and 'before'`: surfaces take no hook. Pass it to `Action.implement`.
