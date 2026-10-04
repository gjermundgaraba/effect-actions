# ActionMcp

MCP tools from implementations, on Effect's native `McpServer`. One `Tool` per served action,
named after it. Two transports: a Streamable HTTP endpoint mounted on the router, or newline-delimited
JSON-RPC on standard I/O for a subprocess. HTTP speaks MCP 2026-07-28 only; stdio also speaks
2025-11-25 and 2025-06-18, as the host negotiates.

## API

Import `@gjermundgaraba/effect-actions/ActionMcp`.

| API                                   | Purpose                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `layerHttp(implementations, options)` | Serve implementations at a Streamable HTTP endpoint.                                               |
| `runStdio(implementations, options)`  | Serve implementations as a subprocess's program on standard I/O; succeeds when the host closes it. |

The options, exported as `LayerHttpOptions` and `Options` (the server's, which `LayerHttpOptions` extends), are the native
`McpServer.layerHttp` / `McpServer.layerStdio` options, except `protocols`, plus `features`. The native ones pass through unchanged; `path` gains a default. Each implementation brings its
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
| `features`                           | Optional native resources, prompts and tools served beside the actions' tools. |

`implementations` is one implementation or a list. Every tool declares its action's errors plus the
built-in `InvalidInput`, `Unauthenticated` and `Forbidden`. `layerHttp`'s layer and `runStdio`'s
program retain the build failures and requirements of their builders, plus native
`IllegalArgumentError`. HTTP needs the router and wraps handler and hook services as request
requirements until middleware provided around it, such as authentication, provides them. stdio
needs `Stdio` and the caller's request services, identity included. Native `McpRequestContext`
is supplied by the server, not required of the host. The server also fails as its `features` do
and needs what they need.

## Canonical

```ts example=mcp.ts
import { Layer } from "effect";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { authenticate } from "./authentication.js";
import { double, status, userActions } from "./handlers.js";

const allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];

// An MCP endpoint is one route, so authentication covers all of its tools. The public tool
// gets an endpoint of its own, which keeps the protected tools unlisted to signed-out callers.
const publicMcp = ActionMcp.layerHttp(status, {
  name: "effect-actions-public",
  version: "0.0.0",
  path: "/mcp/public",
  allowedOrigins,
});

// A list of implementations serves all of their actions, `listChanges` included, which HTTP
// leaves out. `path` defaults to `/mcp`.
const mcp = ActionMcp.layerHttp([userActions, double], {
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

```ts example=mcp-browser.ts
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Greet } from "./quickstart.js";

const allowedOrigins = ["https://ui.example.com"];

const actions = Action.implement(
  Greet,
  ({ name }) => Effect.succeed(`Hello, ${name}!`),
  Action.allowAll,
);

const mcp = ActionMcp.layerHttp(actions, { name: "greetings", version: "1.0.0", allowedOrigins });

// Global router CORS handles preflight outside route-level authentication.
// This example is public; a protected endpoint needs authentication and an authorization hook.
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

```ts example=mcp-stdio.ts
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Cause, Console, Effect, Logger, Runtime, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

const Status = Action.make("status", {
  description: "Report whether the subprocess is ready.",
  success: { ready: Schema.Boolean },
  access: "read",
});

const status = Action.implement(
  Status,
  () => Effect.log("status called").pipe(Effect.as({ ready: true })),
  Action.allowAll,
);

// Serves until the host closes stdin, then exits 0. Protocol messages use stdout
// exclusively: runStdio writes its program's Effect logs and `Console` output to stderr,
// and `LogToStderr` moves the default logger there for the layers provided around it.
ActionMcp.runStdio(status, { name: "effect-actions-stdio", version: "0.1.0" }).pipe(
  Effect.provide(NodeStdio.layer),
  // Report a failure as runMain would, but on stderr.
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause))
      ? Effect.void
      : Console.error(Cause.pretty(cause)),
  ),
  // Outermost, so the default logger of every layer provided above it writes to stderr.
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
```

### Text fields

An action's `text` hint names a string field of its encoded success, the text field, which
its tool sends once, as it is, before the JSON of the rest: a page of Markdown, rather than
the same text JSON-escaped twice. The tool's results carry no structured content, so a host
that prefers structured content shows the model the text instead.

```ts
const ReadPage = Action.make("readPage", {
  description: "Read one page of a document.",
  access: "read",
  input: { url: Schema.String },
  success: { markdown: Schema.String, next: Schema.optionalKey(Schema.String) },
  hints: { text: "markdown" },
});
```

A success is then `content: [<markdown>, <JSON of { next }>]`, without `structuredContent`, and
the tool lists no `outputSchema`. Every endpoint serving the action sends it so, and
`Testing.mcpClient` reads it so ([Testing.md](Testing.md#rules)).

### Native features

Effect's own resources, prompts and tools join an endpoint's tools as its `features`, one layer
merging them:

```ts
ActionMcp.layerHttp(app, {
  name: "acme",
  version: "1.0.0",
  features: Layer.mergeAll(
    McpServer.resource({ uri: "docs://readme", name: "README", content: Effect.succeed("# Acme") }),
    McpServer.prompt({ name: "triage", content: () => Effect.succeed("Triage the issue.") }),
  ),
});
```

They are native: no implementation's `before` hook runs for them, though the authentication
around an endpoint covers them as it covers its tools. A native tool named as an action
replaces it, or is replaced, as Effect's registry keeps one tool per name: name them apart. A
service they need, provided around the endpoint, is shared with the rest of the graph; one
provided to the `features` layer itself is built once per endpoint.

A feature runs with the services it was built with, never a request's: Effect's `resource` and
`prompt` run their content in their build context alone, so a feature cannot read the caller.
Content that depends on the caller is an action. Never provide an identity at startup to
satisfy a feature.

## Rules

- HTTP serves MCP 2026-07-28 and no other revision: it is stateless, every request standing alone. The stateful revisions keep a session per `initialize`, which Effect's HTTP runtime never expires and which no identity owns. Stdio serves 2026-07-28, 2025-11-25 and 2025-06-18, whichever the host negotiates. There is no `protocols` option; Effect owns version checks and negotiation.
- `path` defaults to `/mcp`. `layerHttp` uses the single-endpoint Streamable HTTP transport, never the two-endpoint HTTP+SSE form.
- Requests reaching the native MCP handler with an `Origin` header receive **403** unless that exact origin is listed in `allowedOrigins`. Requests without `Origin` pass this check. Authentication wrapping the endpoint runs first and may reject the request before native Origin validation; the allowlist does not protect authentication from untrusted-origin requests: a check that must run before it is global middleware ([Authentication.md](Authentication.md#rules)).
- `allowedOrigins` is an Origin allowlist, not CORS configuration. Cross-origin browser clients also need outer CORS middleware or a proxy to handle preflight and add response headers. Without it, an allowed-origin `OPTIONS` request receives **405** and even a successful `POST` has no `Access-Control-Allow-Origin`. Keep preflight outside authentication and apply CORS headers to refusals too.
- An endpoint is one route, so middleware provided around `layerHttp`, authentication included, covers every request to it, tool listing included, and every tool it serves, public ones too. To serve tools under different authentication or middleware, or without any, mount them on different paths with separate `layerHttp` calls; one URL for signed-out and signed-in callers takes an optional identity instead ([Authentication.md](Authentication.md#one-url-for-signed-out-callers)).
- Every action of the implementations passed becomes a tool, named after the action, with the action's `hints`. To keep an action off MCP, give the endpoint a share of the actions that are tools, and leave it out of that list ([Action.md](Action.md#contracts)).
- Builders and request services follow the [dependency lifetimes](guarantees.md#dependency-lifetimes), and the hook the [authorization rules](guarantees.md#authorization). Only the tool registry is fresh per endpoint.
- A handler may yield `McpServer.McpServer`, its endpoint's registry, to send notifications such as progress: the endpoint provides it, and no host owes it. Served on another surface too, where nothing provides it, read it with `Effect.serviceOption`.
- Every served action's input must be one object with keys, as a tool's arguments are: fields, a struct or a class, identified, recursive or suspended, a record, or a declared type whose JSON Schema is an object. `layerHttp` and `runStdio` read the JSON Schema the native server reads, and throw for any other when they are called, naming the actions: a union, an array, a scalar, or an object without keys such as `Schema.Struct({})`. Omit `input`, or give `{}`, for a tool with no arguments.
- A tool's `inputSchema` is its input's JSON Schema, on every revision, closed with `additionalProperties: false` where the input declares its fields; a record's lists its value schema there instead. Undeclared arguments are refused on every revision, as invalid arguments.
- A success is sent as it is. On 2026-07-28, over HTTP and stdio, it is `structuredContent: <encoded success>`, of any JSON type (`null` for an action that returns nothing), and one text block holding the same JSON, and the tool's `outputSchema` describes the encoded success. Stdio's earlier revisions, 2025-11-25 and 2025-06-18, structure less: they carry only an object as `structuredContent`, and list only an object-rooted `outputSchema`. A success they do not structure is text alone: its JSON, or a string success the string itself. A declared error is an `isError` result whose text content is the error's JSON encoding, the same bytes HTTP sends as the body, and no `structuredContent`.
- With a text field, a success holding it as a string is `content: [<field>, <JSON of the rest>]`: the field once, verbatim, and the rest once. A success without the field as a string, such as one that omits an optional field, is `content: [<JSON of the whole>]`. Neither carries `structuredContent`, on any revision, and the tool lists no `outputSchema`, so a host that prefers structured content has none and shows the model the text. The tool's failures are answered as any tool's; every other surface serves the whole success ([guarantees.md](guarantees.md#wire-behavior)).
- A text field must be a top-level property of the success's JSON Schema: a field of a struct or class success. `Action.make`'s types accept only a string field, optional or not, of the encoded success. Where they could not tell, as for a union of one struct, an erased success, or a hint typed only as `string`, building the layer refuses a field that is not such a property; one that is not a string never holds one, so every success is sent whole.
- On 2026-07-28, over HTTP and over stdio, the native server adds `_meta["io.modelcontextprotocol/serverInfo"]` and `resultType: "complete"` to every result, beside a tool result's own fields (`isError: false` on a success); the earlier revisions stdio speaks add neither. `serverInfo` is the options' `name`, `version`, `description`, `websiteUrl` and `icons`, as given, so a 2026-07-28 result's encoded size is the size of its own fields plus a fixed overhead per endpoint or subprocess.
- Invalid arguments are answered by the native `McpServer`: from 2025-11-25 on, an `isError` result with a message for the model, such as `Invalid parameters for tool 'greet': Expected string\n  at ["name"]`; on earlier stdio revisions, a JSON-RPC error. HTTP's `InvalidInput` does not apply.
- Defects and encoding failures produce the generic `isError` text `Tool execution failed due to an internal server error.`; the cause is logged, not sent.
- Every caller sees every tool of the endpoint ([guarantees.md](guarantees.md#scope)); authorization happens in each implementation's `before`.
- Cancellation is Effect's native RPC interruption. Over HTTP there is no session, so `notifications/cancelled` interrupts nothing. A tool call ends with its HTTP request, whose lifetime (for example, whether a client disconnect interrupts it) is the host's.
- Handlers may yield `McpSchema.McpRequestContext` for the client's declared information; the native server supplies it to every tool call, so it is never a router or host requirement.
- `runStdio` is the subprocess's whole program: it serves until the host closes stdin, then succeeds, so the process exits 0. Closing stdin interrupts every call in flight; `runStdio` succeeds once they have stopped, after any uninterruptible region has completed. An interrupted call gets no result: no answer, or a JSON-RPC error. MCP hosts close stdin to shut a server down; a script piping requests keeps stdin open until it has read every answer. A signal interrupts it, as any program. Provide `Stdio` and its services to it and run it, `NodeRuntime.runMain`.
- stdio: the host supplies `Stdio` (`NodeStdio.layer`) and any request-time services explicitly, including the trusted identity. Each implementation's `before` runs. Tool arguments never establish identity.
- `runStdio` gives its program a `Console` that writes every method through the `error` of the console it runs with, to stderr, since stdout carries the protocol: every console logger, the default one included, `Console.log`, and the counters, timers and group labels Node's console prints on stdout. A counter or a timer prints its label and its count or the milliseconds since it started, a group prints its label without indenting what follows, and `clear` does nothing. Layers provided around `runStdio` run outside its program: provide `Logger.LogToStderr` outermost, as the example does, which moves the default logger to stderr, but not their `Console` output or a logger writing through `Console.log`, such as `Logger.consoleJson`; log JSON with `Logger.withConsoleError(Logger.formatJson)` instead. Keep the global `console.log` and other direct writes off stdout.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates tool names, not application context.
- Every tool declares the built-in errors ([guarantees.md](guarantees.md#wire-behavior)). A `before` refusal is an `isError` result whose text is its JSON, `{"_tag":"Forbidden","message":"Not allowed."}`, exactly like an action's own error.
- The hook runs after the native server decodes the tool's arguments.
- Under `Authentication.make`, a step-up refusal is an HTTP 401 or 403 instead of a tool result ([guarantees.md](guarantees.md#authorization)); without it, a tool result. On a `Forbidden`'s `insufficient_scope` challenge, an MCP client re-authorizes with those scopes and retries.
- That holds only while nothing of the response has been sent. Once a handler's notification, such as progress, has started a 200 event stream, a later refusal is the tool's `isError` result in it. A hook runs before its handler, so its refusal is always the status.
- Authentication refuses before the MCP handler too: an HTTP 401 or 403. An MCP client reads the 401's `WWW-Authenticate` challenge and finds its authorization server through the discovery `Authentication.make` publishes for a protected resource ([Authentication.md](Authentication.md)).

## Failure modes

- `MCP tool input must be one object with keys, such as a struct: <name>, ...` thrown by `layerHttp` or `runStdio`: those actions' input is a union, an array, a scalar, or an object without keys such as `Schema.Struct({})`. Wrap a union in a field, `input: { notification: Schema.Union([Email, Sms]) }`, omit `input` (or give `{}`) for no arguments, or leave the action off MCP.
- `Type 'CurrentActor' is not assignable to type 'never'` where the server is launched, with `CurrentActor` among the endpoint's startup requirements rather than its `Request<"Requires", ...>`: a feature reads a request service, which it never receives ([native features](#native-features)). Serve that content as an action.
- A native `McpServer.resource`, `McpServer.prompt` or `McpServer.toolkit` layer merged beside `layerHttp` builds without error and is never served: `resources/list` is empty, `prompts/list` is not found, and `tools/list` lists only the actions. Each endpoint's registry is its own: pass them as its `features`.
- An MCP client gets an `isError` refusal instead of the 401 or 403 it re-authorizes on: the handler sent a notification before refusing, so the response had already started. Refuse in the implementation's hook, before the handler runs.
- `Duplicate MCP tool: <name>` thrown at the `layerHttp` or `runStdio` call: two implementations on one endpoint serve actions of the same name. Split the endpoint, or rename one action.
- `Type 'CurrentActor' is not assignable to type 'never'` where the server is launched, or `Request<"Requires", CurrentActor>` in the endpoint's type: a handler or hook yields a request service that no middleware around the endpoint provides. Provide the authentication, `Layer.provide(authenticate)`, or other middleware (`Layer.provide(middleware.layer)`) on that `layerHttp`; never an identity at startup ([Authentication.md](Authentication.md#failure-modes)).
- A public tool demands credentials: it shares an endpoint with authenticated ones, and the authentication covers the whole endpoint. Serve it on an endpoint of its own, or keep one URL with an optional identity ([Authentication.md](Authentication.md#one-url-for-signed-out-callers)).
- Client reports a broken transport from a stdio subprocess: something wrote to stdout, such as `console.log`, or a layer provided around `runStdio` did, through the default logger without `Logger.LogToStderr` outermost, or through `Console` or a logger such as `Logger.consoleJson`, which `LogToStderr` does not move. Remove the write, provide `LogToStderr`, or log JSON with `Logger.withConsoleError(Logger.formatJson)`.
- A stdio host asking for 2025-03-26 or 2024-11-05 is offered 2025-11-25 in the `initialize` result, as MCP negotiates, and disconnects if it cannot speak it. Update the host.
- An MCP client cannot connect over HTTP: a request answers `400` with JSON-RPC error `-32020`. The client opens with `initialize`, as the 2025 revisions do, and HTTP serves only 2026-07-28. Pin the client to it (the official client: `versionNegotiation: { mode: { pin: "2026-07-28" } }`), or serve that host over stdio. Codex is such a client: it opens HTTP with `initialize` (measured on 0.159.0), so serve it over stdio.
- An Origin-bearing request reaches the native handler and gets an empty 403: its `Origin` is not in `allowedOrigins`. Add the exact origin only if the deployment trusts it.
- A disallowed Origin receives 401 instead: wrapping authentication rejected it before the native Origin check. A Host or Origin check that must run before authentication is global middleware ([Authentication.md](Authentication.md#rules)).
- Browser calls fail despite an allowed Origin: configure CORS outside authentication and the MCP handler (see the browser example above). The native allowlist alone neither handles preflight nor adds CORS response headers.
- Layer build dies with `MCP tool '<name>' cannot send '<field>' as text: it is not a top-level property of its success`: the success's JSON Schema has no such top-level property, and the types did not tell. The success is a union of one struct, which they take for a struct, or they could not read it, as for an erased success or an action a helper's type parameter stands for. Name a top-level field, make the success one struct, or drop the hint.
- A tool sends every success whole, as one JSON text block without `structuredContent`: its `text` hint names a field that is not a string, where the types could not read the success or the hint, as for an erased success or a hint typed only as `string`. Name a string field.
- Type error on `text` in `hints` at `Action.make`, such as `Type '"words"' is not assignable to type '"markdown" | "note"'`, or, for a success with no text field, to `undefined` or `never`: the field is not a top-level string field of the action's encoded success. It has another type or does not exist, or the success is not one struct: a scalar, an array, a union or a record. Name a string field, or drop the hint.
- A client other than `Testing.mcpClient` finds no `structuredContent` in a tool's result, and a field of the success missing from the JSON of its text: the action has a `text` hint, so the field is sent raw as the first text block, with the rest as JSON in the second. Read them there.
- `Object literal may only specify known properties, and 'tools'`: a text field is the action's `text` hint. Move it to `Action.make`'s `hints`.
- `Object literal may only specify known properties, and 'protocols'`: the revisions are fixed. Delete the option.
- `Object literal may only specify known properties, and 'before'`: surfaces take no hook. Pass it to `Action.implement`.
