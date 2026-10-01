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

The options, exported as `LayerHttpOptions<A>` and `Options<A>` (the server's, which `LayerHttpOptions` extends), are the native
`McpServer.layerHttp` / `McpServer.layerStdio` options, except `protocols`, plus `tools`, which the served actions `A` type. The native ones pass through unchanged; `path` gains a default. Each implementation brings its
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
| `tools`                              | Each action's tool options, by action name; `text` names its text field.       |

`implementations` is one implementation or a list. Every tool declares its action's errors plus the
built-in `InvalidInput`, `Unauthenticated` and `Forbidden`. `layerHttp`'s layer and `runStdio`'s
program retain the build failures and requirements of their builders, plus native
`IllegalArgumentError`. HTTP needs the router and wraps handler and hook services as request
requirements until middleware provided around it, such as authentication, provides them. stdio
needs `Stdio` and the caller's request services, identity included. Native `McpRequestContext`
is supplied by the server, not required of the host.

## Canonical

```ts
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

```ts
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

`tools` names, for an action's tool, a string field of its encoded success, the text field,
which MCP sends once, as it is, before the JSON of the rest: a page of Markdown, rather than
the same text JSON-escaped twice.

```ts
// ReadPage succeeds with { markdown: Schema.String, next: Schema.optionalKey(Schema.String) }.
const readPage = Action.implement(ReadPage, read, authorize);

const tools = { readPage: { text: "markdown" } } as const;

const mcp = ActionMcp.layerHttp(readPage, { name: "pages", version: "1.0.0", tools });
```

A success is then `content: [<markdown>, <JSON of { next }>]` and `structuredContent: { next }`,
and the tool lists no `markdown` in its `outputSchema`. A test client takes the same `tools`,
`Testing.mcpClient([ReadPage], { tools })` ([Testing.md](Testing.md#rules)).

## Rules

- HTTP serves MCP 2026-07-28 and no other revision: it is stateless, every request standing alone. The stateful revisions keep a session per `initialize`, which Effect's HTTP runtime never expires and which no identity owns. Stdio serves 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, whichever the host negotiates. There is no `protocols` option; Effect owns version checks and negotiation.
- `path` defaults to `/mcp`. `layerHttp` uses the single-endpoint Streamable HTTP transport, never the two-endpoint HTTP+SSE form.
- Requests reaching the native MCP handler with an `Origin` header receive **403** unless that exact origin is listed in `allowedOrigins`. Requests without `Origin` pass this check. Authentication wrapping the endpoint runs first and may reject the request before native Origin validation; the allowlist does not protect authentication from untrusted-origin requests: a check that must run before it is global middleware ([Authentication.md](Authentication.md#rules)).
- `allowedOrigins` is an Origin allowlist, not CORS configuration. Cross-origin browser clients also need outer CORS middleware or a proxy to handle preflight and add response headers. Without it, an allowed-origin `OPTIONS` request receives **405** and even a successful `POST` has no `Access-Control-Allow-Origin`. Keep preflight outside authentication and apply CORS headers to refusals too.
- An endpoint is one route, so middleware provided around `layerHttp`, authentication included, covers every request to it, tool listing included, and every tool it serves, public ones too. To serve tools under different authentication or middleware, or without any, mount them on different paths with separate `layerHttp` calls; one URL for signed-out and signed-in callers takes an optional identity instead ([Authentication.md](Authentication.md#one-url-for-signed-out-callers)).
- Every action of the implementations passed becomes a tool, named after the action, with the action's `hints` (except on stdio revision 2024-11-05, which has no tool hints). To keep an action off MCP, give the endpoint a share of the actions that are tools, and leave it out of that list ([Action.md](Action.md#contracts)).
- Builders and request services follow the [dependency lifetimes](guarantees.md#dependency-lifetimes), and the hook the [authorization rules](guarantees.md#authorization). Only the tool registry is fresh per endpoint.
- Every served action's input must be one object with keys, as a tool's arguments are: fields, a struct or a class, identified or recursive, or a record. `layerHttp` and `runStdio` refuse any other with a type error naming the actions: a union, an array, a scalar, or an object without keys such as `Schema.Struct({})`. Input the types do not check, the native server refuses when the layer is built: erased input, and a helper's own type parameter, passed alone or spread into a list (`layerHttp([...apps, status], options)`). An argument chosen by a condition, `debug ? [status, inspect] : [status]`, compiles when one choice's input passes: the native server refuses another's when the layer is built. When no choice's input passes, it is a type error. Omit `input`, or give `{}`, for a tool with no arguments.
- A tool's `inputSchema` is its input's JSON Schema over HTTP and on stdio from 2025-06-18 on, closed with `additionalProperties: false` where the input declares its fields; a record's lists its value schema there instead. On 2025-03-26 and 2024-11-05, Effect's adapters list only its root's `type`, `properties` and `required`: no `additionalProperties`, so a host sees the input open, and no `$defs`, so a field's `$ref`, as an identified or recursive schema has, resolves nowhere. Undeclared arguments are refused on every revision, as invalid arguments.
- A success is sent as it is. On 2026-07-28, over HTTP and stdio, it is `structuredContent: <encoded success>`, of any JSON type (`null` for an action that returns nothing), and one text block holding the same JSON, and the tool's `outputSchema` describes the encoded success. Stdio's earlier revisions structure less: 2025-11-25 and 2025-06-18 carry only an object as `structuredContent`, and list only an object-rooted `outputSchema`; 2025-03-26 and 2024-11-05 carry neither. A success they do not structure is text alone: its JSON, or a string success the string itself. A declared error is an `isError` result whose text content is the error's JSON encoding, the same bytes HTTP sends as the body, and no `structuredContent`.
- With a text field, a success holding it as a string is `content: [<field>, <JSON of the rest>]` and, on a revision with structured content, `structuredContent: <the rest>`. The field is sent once, verbatim, and is left out of `structuredContent` and of the listed `outputSchema`, its `required` included. A success without the field as a string, such as one that omits an optional field, is sent whole. The tool's failures are answered as any tool's; every other surface serves the whole success ([guarantees.md](guarantees.md#wire-behavior)).
- A text field must be a top-level property of the success's JSON Schema: a field of a struct or class success. The types accept only a string field, optional or not, of the named action's encoded success, and only a served action's name as a key of `tools`. Where the types could not tell, as for a union of one struct or an erased success, building the layer refuses a field that is not such a property; one that is not a string is left out of the listed `outputSchema`, and every success is sent whole. `layerHttp` and `runStdio` throw `Unknown tools: <names>` on a key no served action has where the types did not check it.
- For an argument chosen by a condition, `debug ? [status, dump] : [status]`, the types accept a key any choice serves, and a choice that does not serve it throws `Unknown tools` at the call. For a helper's own type parameter, passed alone or spread into a list (`layerHttp([...apps, status], options)`), they check the entries of the helper's own actions, and leave other keys to that throw and to the layer build, as for input.
- On 2026-07-28, over HTTP and over stdio, the native server adds `_meta["io.modelcontextprotocol/serverInfo"]` and `resultType: "complete"` to every result, beside a tool result's own fields (`isError: false` on a success); the earlier revisions stdio speaks add neither. `serverInfo` is the options' `name`, `version`, `description`, `websiteUrl` and `icons`, as given, so a 2026-07-28 result's encoded size is the size of its own fields plus a fixed overhead per endpoint or subprocess.
- Invalid arguments are answered by the native `McpServer`: from 2025-11-25 on, an `isError` result with a message for the model, such as `Invalid parameters for tool 'greet': Expected string\n  at ["name"]`; on earlier stdio revisions, a JSON-RPC error. HTTP's `InvalidInput` does not apply.
- Defects and encoding failures produce the generic `isError` text `Tool execution failed due to an internal server error.`; the cause is logged, not sent.
- Every caller sees every tool of the endpoint ([guarantees.md](guarantees.md#scope)); authorization happens in each implementation's `before`.
- Cancellation is Effect's native RPC interruption. Over HTTP there is no session, so `notifications/cancelled` interrupts nothing. A tool call ends with its HTTP request, whose lifetime (for example, whether a client disconnect interrupts it) is the host's.
- Handlers may yield `McpSchema.McpRequestContext` for the client's declared information; the native server supplies it to every tool call, so it is never a router or host requirement.
- `runStdio` is the subprocess's whole program: it serves until the host closes stdin, then succeeds, so the process exits 0. Closing stdin interrupts every call in flight; `runStdio` succeeds once they have stopped, after any uninterruptible region has completed. An interrupted call gets no result: no answer, or a JSON-RPC error. MCP hosts close stdin to shut a server down; a script piping requests keeps stdin open until it has read every answer. A signal interrupts it, as any program. Provide `Stdio` and its services to it and run it, `NodeRuntime.runMain`.
- stdio: the host supplies `Stdio` (`NodeStdio.layer`) and any request-time services explicitly, including the trusted identity. Each implementation's `before` runs. Tool arguments never establish identity.
- `runStdio` gives its program a `Console` that writes every method to stderr, since stdout carries the protocol: every console logger, the default one included, `Console.log`, and the counters, timers and group labels Node's console prints on stdout. It counts, times and warns with the labels of Node's console, and a group indents every line of a string first argument and the first line of a value it inspects. A timer prints seconds past a minute, `dir` takes no inspect options, `table` prints its data without a grid or column filter, and `clear` does nothing. Layers provided around `runStdio` run outside its program: provide `Logger.LogToStderr` outermost, as the example does, which moves the default logger to stderr, but not their `Console` output or a logger writing through `Console.log`, such as `Logger.consoleJson`; log JSON with `Logger.withConsoleError(Logger.formatJson)` instead. Keep the global `console.log` and other direct writes off stdout.
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
- `Type 'CurrentActor' is not assignable to type 'never'` where the server is launched, or `Request<"Requires", CurrentActor>` in the endpoint's type: a handler or hook yields a request service that no middleware around the endpoint provides. Provide the authentication, `Layer.provide(authenticate)`, or other middleware (`Layer.provide(middleware.layer)`) on that `layerHttp`; never an identity at startup ([Authentication.md](Authentication.md#failure-modes)).
- A public tool demands credentials: it shares an endpoint with authenticated ones, and the authentication covers the whole endpoint. Serve it on an endpoint of its own, or keep one URL with an optional identity ([Authentication.md](Authentication.md#one-url-for-signed-out-callers)).
- Client reports a broken transport from a stdio subprocess: something wrote to stdout, such as `console.log`, or a layer provided around `runStdio` did, through the default logger without `Logger.LogToStderr` outermost, or through `Console` or a logger such as `Logger.consoleJson`, which `LogToStderr` does not move. Remove the write, provide `LogToStderr`, or log JSON with `Logger.withConsoleError(Logger.formatJson)`.
- An MCP client cannot connect over HTTP: a request answers `400` with JSON-RPC error `-32020`. The client opens with `initialize`, as the 2025 revisions do, and HTTP serves only 2026-07-28. Pin the client to it (the official client: `versionNegotiation: { mode: { pin: "2026-07-28" } }`), or serve that host over stdio. Codex is such a client: it opens HTTP with `initialize` (measured on 0.159.0), so serve it over stdio.
- An Origin-bearing request reaches the native handler and gets an empty 403: its `Origin` is not in `allowedOrigins`. Add the exact origin only if the deployment trusts it.
- A disallowed Origin receives 401 instead: wrapping authentication rejected it before the native Origin check. A Host or Origin check that must run before authentication is global middleware ([Authentication.md](Authentication.md#rules)).
- Browser calls fail despite an allowed Origin: configure CORS outside authentication and the MCP handler (see the browser example above). The native allowlist alone neither handles preflight nor adds CORS response headers.
- Layer build dies with `MCP tool '<name>' cannot send '<field>' as text: it is not a top-level property of its success`: the success's JSON Schema has no such top-level property, and the types did not tell. The success is a union of one struct, which they take for a struct, or they could not read it, as for an erased success or an action a helper's type parameter stands for. Name a top-level field, make the success one struct, or leave the tool out of `tools`.
- A tool sends every success whole, and its listed `outputSchema` leaves out a field its `structuredContent` has: its `text` names a field that is not a string, where the types could not read the success, as for an erased one or an action a helper's type parameter stands for. Name a string field.
- Type error on `text` in `tools`, such as `Type '"words"' is not assignable to type '"markdown" | "note"'`, or, for a success with no text field, to `undefined` or `never`: the field is not a top-level string field of the action's encoded success. It has another type or does not exist, or the success is not one struct: a scalar, an array, a union or a record. Name a string field, or give the tool no `text`.
- `Object literal may only specify known properties` on a key of `tools`, or `Unknown tools: <names>` thrown at `layerHttp` or `runStdio` where the types did not check the key: no served action has that name. Name the action, or drop the key. For an argument chosen by a condition, the choice that throws does not serve that action: choose `tools` by the same condition, `tools: debug ? { dump: { text: "markdown" } } : {}`, or split the call.
- `Type 'string' is not assignable to type '"markdown" | ...'` for `tools` declared apart from the call: its `text` widened to `string`. Declare it `as const`.
- A client finds a field of the success in neither `structuredContent` nor its JSON: it is the endpoint's text field, sent raw as the first text block. Read it there, or give `Testing.mcpClient` the endpoint's `tools`.
- `Object literal may only specify known properties, and 'protocols'`: the revisions are fixed. Delete the option.
- `Object literal may only specify known properties, and 'before'`: surfaces take no hook. Pass it to `Action.implement`.
