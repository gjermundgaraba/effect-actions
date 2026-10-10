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
`McpServer.layerHttp` / `McpServer.layerStdio` options, except `protocols`, plus `actions` and `features`, and for `layerHttp`, `authentication`. The native ones pass through unchanged; `path` gains a default. Each implementation brings its
authorization ([Action.md](Action.md#implementations)); an endpoint serving protected actions
names their authentication descriptor and requires its provider
([Authentication.md](Authentication.md)).

| Option                               | Meaning                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `name`, `version`                    | Required native server information.                                            |
| `description`, `websiteUrl`, `icons` | Optional native server information, sent to clients with `name` and `version`. |
| `instructions`                       | Optional native server instructions.                                           |
| `extensions`                         | Optional native server capability extensions.                                  |
| `path`                               | HTTP endpoint path; HTTP only, defaults to `/mcp`.                             |
| `allowedOrigins`                     | Optional exact Origin allowlist; HTTP only, not CORS configuration.            |
| `authentication`                     | HTTP only: the protected tools' descriptor, required where one is served.      |
| `actions`                            | Optional actions that are tools, among the implementations'; defaults to all.  |
| `features`                           | Optional native resources, prompts and tools served beside the actions' tools. |

`implementations` is one implementation or a list. Every tool declares its action's errors plus the
built-in `InvalidInput`, `Unauthenticated` and `Forbidden`. `layerHttp`'s layer and `runStdio`'s
program retain the build failures and requirements of their builders, plus native
`IllegalArgumentError`. HTTP needs the router, the descriptor's provider where it serves a
protected action, and wraps handler and authorizer services as request requirements until middleware provided around it provides them, the
identity excepted, which the provider supplies. stdio needs `Stdio` and the caller's request
services, the identity of its protected tools included. Native `McpRequestContext`
is supplied by the server, not required of the host. The server also fails as its `features` do
and needs what they need, except the registry, `McpServer.McpServer`, which the endpoint provides,
such as to a feature registering with `McpServer.registerResource`.

## Canonical

One endpoint serves the public and the protected tools: discovery and `status` answer anyone,
and every other request authenticates before the endpoint decodes it.

```ts example=mcp.ts
import { Layer } from "effect";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { authenticate } from "./authentication.js";
import { Login } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

const allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];

// One URL: discovery and `status` answer anyone; a protected tool's call authenticates
// before its arguments are decoded, with the 401 an MCP client signs in on.
export const layer = ActionMcp.layerHttp([status, userActions, double], {
  name: "effect-actions",
  version: "0.0.0",
  allowedOrigins,
  authentication: Login,
}).pipe(Layer.provide(authenticate));
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

const actions = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));

const mcp = ActionMcp.layerHttp(actions, { name: "greetings", version: "1.0.0", allowedOrigins });

// Global router CORS handles preflight outside route-level authentication.
// This example is public; an endpoint serving protected actions takes their `authentication`.
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
import { Effect, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

const Status = Action.make("status", {
  description: "Report whether the subprocess is ready.",
  success: { ready: Schema.Boolean },
  readOnly: true,
  caller: Action.Anyone,
});

const status = Action.implement(Status, () =>
  Effect.log("status called").pipe(Effect.as({ ready: true })),
);

// Serves until the host closes stdin, then exits 0. Protocol messages use stdout
// exclusively: runStdio writes its program's Effect logs and `Console` output to stderr, and
// `logToStderr`, applied last, does so for the layers provided around it, and reports a failure
// there rather than as runMain would, on stdout.
ActionMcp.runStdio(status, { name: "effect-actions-stdio", version: "0.1.0" }).pipe(
  Effect.provide(NodeStdio.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
```

### Media

A tool returning an image is an action like the others: an `Action.Image` field of its success
([Action.md](Action.md#contracts)) is lifted into an image block, the content a model reads as
an image, and the rest of the success is sent as any success is.

```ts example=mcp-image.ts
import { Buffer } from "node:buffer";
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";

const Screen = Schema.Struct({ id: Schema.Int, title: Schema.String });

class TerminusError extends Schema.TaggedError<TerminusError>()("TerminusError", {
  message: Schema.String,
}) {}

// The image is a field of the success. Over MCP it is lifted into an image block, after the
// JSON text of `{ screen }`, which is also the structured content; elsewhere it is JSON, the
// bytes in base64.
const GetScreenImage = Action.make("get_screen_image", {
  description: "Fetch the rendered image for a listed screen.",
  input: { screen_id: Schema.Int },
  success: { screen: Screen, image: Action.Image },
  error: TerminusError,
  readOnly: true,
  caller: Action.Anyone,
});

// A one-pixel PNG stands in for a rendered screen.
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const getScreenImage = Action.implement(GetScreenImage, ({ screen_id }) =>
  screen_id === 1
    ? Effect.succeed({
        screen: { id: screen_id, title: "Home" },
        image: { data: pixel, mimeType: "image/png" },
      })
    : Effect.fail(new TerminusError({ message: `No screen ${screen_id}.` })),
);

// A subprocess MCP server, as mcp-stdio.ts is: launch it from an MCP client.
ActionMcp.runStdio(getScreenImage, { name: "terminus", version: "0.1.0" }).pipe(
  Effect.provide(NodeStdio.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
```

`get_screen_image` with `{ "screen_id": 1 }` answers, on every revision, beside the fields the
native server adds to every result ([Rules](#rules)):

```json
{
  "content": [
    { "type": "text", "text": "{\"screen\":{\"id\":1,\"title\":\"Home\"}}" },
    {
      "type": "image",
      "data": "iVBORw0KGgo...",
      "mimeType": "image/png",
      "_meta": { "effect-actions/field": "image" }
    }
  ],
  "structuredContent": { "screen": { "id": 1, "title": "Home" } }
}
```

The tool lists the `outputSchema` of `{ screen }`. HTTP, a CLI command and a Toolkit send the
same success as JSON, the image `{ "data": "<base64>", "mimeType": "image/png" }`
([guarantees.md](guarantees.md#wire-behavior)).

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

They are native: no implementation's authorization runs for them. On an endpoint
naming a descriptor, every request a feature answers authenticates, its listings, completions
and subscriptions included, so a public resource or prompt beside protected tools takes an
endpoint of its own. The features register before the actions, and a native tool named as an
action is refused when the endpoint builds: Effect's registry keeps one tool per name, and the
endpoint's authentication decides by that name. A service they need, provided around the endpoint, is shared with the rest of the graph; one
provided to the `features` layer itself is built once per endpoint.

A feature runs with the services it was built with, never a request's: Effect's `resource` and
`prompt` run their content in their build context alone, so a feature cannot read the caller.
Content that depends on the caller is an action. Never provide an identity at startup to
satisfy a feature.

## Rules

- HTTP serves MCP 2026-07-28 and no other revision: it is stateless, every request standing alone. The stateful revisions keep a session per `initialize`, which Effect's HTTP runtime never expires and which no identity owns. Stdio serves 2026-07-28, 2025-11-25 and 2025-06-18, whichever the host negotiates. There is no `protocols` option; Effect owns version checks and negotiation.
- `path` defaults to `/mcp`. `layerHttp` uses the single-endpoint Streamable HTTP transport, never the two-endpoint HTTP+SSE form.
- Requests reaching the native MCP handler with an `Origin` header receive **403** unless that exact origin is listed in `allowedOrigins`. Requests without `Origin` pass this check. The endpoint's authentication runs first and may reject the request before native Origin validation; the allowlist does not protect authentication from untrusted-origin requests: a check that must run before it is global middleware ([Authentication.md](Authentication.md#rules)).
- `allowedOrigins` is an Origin allowlist, not CORS configuration. Cross-origin browser clients also need outer CORS middleware or a proxy to handle preflight and add response headers. Without it, an allowed-origin `OPTIONS` request receives **405** and even a successful `POST` has no `Access-Control-Allow-Origin`. Keep preflight outside authentication and apply CORS headers to refusals too.
- An endpoint serving a protected action names its descriptor, `authentication: Login`, and requires its provider, `Layer.provide(authenticate)`; the types refuse one without it, and `layerHttp` throws for plain JavaScript. One serving only public actions names none, and authenticates nothing.
- An endpoint whose every tool is protected authenticates every request before reading its body, so a host signs in when it connects.
- A mixed endpoint, serving public and protected tools on one URL, decides from the request's MCP routing headers before the native server reads its body, as the native server refuses a request whose headers disagree with its body. Discovery, `server/discover` and `tools/list`, `notifications/cancelled`, and a call of a public tool pass without a credential; a credential presented there is verified, and refused with 401 if it does not verify, while one its scheme decodes as empty passes as none. Every other request authenticates: a protected tool's call, before its arguments are decoded, and every native feature's request, `prompts/get`, `resources/read`, their listings, `completion/complete` and `subscriptions/listen` included, as does a method a later revision adds. The `Mcp-Name` header is compared as it is: a `tools/call` naming no public tool by it, a Base64-encoded name (`=?base64?...?=`) included, authenticates, and so does a request whose headers name no method: it fails closed.
- So signed-out callers of a mixed endpoint list every tool, protected ones included, and call the public ones; a protected tool's call answers the 401 an MCP client signs in on, then retries. To keep protected tools unlisted to signed-out callers, serve the public tools on an endpoint of their own, with separate `layerHttp` calls on different paths.
- A public tool never gets the identity, signed in or not; an action whose answer depends on the caller is protected. Middleware provided around `layerHttp` covers every request to the endpoint, before its authentication; an endpoint takes no layer middleware of its own, so middleware that reads the identity is not available over MCP ([ActionHttp.md](ActionHttp.md#rules)).
- Every action of the implementations passed becomes a tool, named after the action, with the action's `mcp` hints, its `title` and `_meta` included, unless `actions` lists the tools: then only those, each behind its implementation's authorizer and from its builder's one run, and an implementation holding none of them is not built. To keep an action off MCP, leave it out of `actions`: `ActionMcp.layerHttp([users, pages], { name, version, actions: Tools })` ([Action.md](Action.md#contracts)). Only a listed action's input must suit MCP, and only listed actions' names must be unique. The types take only actions of the implementations, and owe only what the listed actions' handlers and authorizers, and the builders holding them, need. Whether the endpoint authenticates follows the listed actions alone.
- Builders and request services follow the [dependency lifetimes](guarantees.md#dependency-lifetimes), and authorization the [authorization rules](guarantees.md#authorization). Only the tool registry is fresh per endpoint.
- A handler may yield `McpServer.McpServer`, its endpoint's registry, to send notifications such as progress: the endpoint provides it, and no host owes it. Served on another surface too, where nothing provides it, read it with `Effect.serviceOption`.
- Every served action's input must be one object with keys, as a tool's arguments are: fields, a struct or a class, identified, recursive or suspended, a record, or a declared type whose JSON Schema is an object. `layerHttp` and `runStdio` read the JSON Schema the native server reads, and throw for any other when they are called, naming the actions: a union, an array, a scalar, or an object without keys such as `Schema.Struct({})`. Omit `input`, or give `{}`, for a tool with no arguments.
- A tool's `inputSchema` is its input's JSON Schema, on every revision, closed with `additionalProperties: false` where the input declares its fields; a record's lists its value schema there instead. Undeclared arguments are refused on every revision, as invalid arguments.
- A success without a media field is sent as it is. On 2026-07-28, over HTTP and stdio, it is `structuredContent: <encoded success>`, of any JSON type (`null` for an action that returns nothing), and one text block holding the same JSON, and the tool's `outputSchema` describes the encoded success. Stdio's earlier revisions, 2025-11-25 and 2025-06-18, structure less: they carry only an object as `structuredContent`, and list only an object-rooted `outputSchema`. A success they do not structure is text alone: its JSON, or a string success the string itself. A declared error is an `isError` result whose text content is the error's JSON encoding, the same bytes HTTP sends as the body, and no `structuredContent`.
- A media field is lifted out of the result ([Media](#media)): each becomes a content block of its own, after the one text block, in field order: for an `Action.Image`, an `image` block of its `data` in base64 and its `mimeType`. The rest of the success is sent as any success is: `structuredContent` is the encoded success without its media fields, the tool's `outputSchema` describes that, and the text block is its JSON, exactly. The rest is an object, so stdio's 2025 revisions structure it too.
- An absent optional media field sends no block. An array field sends one block per element, in order.
- A success that is media, `success: Action.Image`, or whose every field is, sends its blocks alone: no `structuredContent`, no text block, and the tool lists no `outputSchema`. A success that is an array of media, `success: Schema.Array(Action.Image)`, sends one block per element, alone too. Blocks of a success that is media carry no `_meta`, as no field names them.
- Each block lifted from a field names it in its `_meta`, `{ "effect-actions/field": "image" }`, on every revision, so a client reassembles the success from the structured content and the blocks, as `Testing.mcpClient` does ([Testing.md](Testing.md#rules)). A client that does not know the key ignores it, as MCP's `_meta` is open.
- Media is lifted only from a top-level field of a struct success (`Schema.Struct` or fields, `Schema.suspend`ed or not), the field bare, `Schema.optional` or `Schema.optionalKey`, or an array, `Schema.Array` or `Schema.NonEmptyArray`, or from a success that is media or such an array. An `Action.Image` anywhere else in an action the endpoint serves is refused when `layerHttp` or `runStdio` is called, naming the actions, as an input that is not one object is: nested in a field, in a union or a record, in an optional array field, whose blocks cannot tell absent from empty, in a `Schema.Class` success or a struct with an encoding of its own, such as `Schema.encodeKeys`, or given an encoding of its own itself, which would send it as something else, in the input or in an error. Only the listed `actions` are checked.
- A media field's own annotations, such as its `description`, and those of a success that is media, reach no model: the `outputSchema` leaves the field out, a success that is media lists none, and an image block carries no description. Describe the image in the action's `description`.
- A declared error is unchanged by media: an `isError` result whose text is the error's JSON.
- On 2026-07-28, over HTTP and over stdio, the native server adds `_meta["io.modelcontextprotocol/serverInfo"]` and `resultType: "complete"` to every result, beside a tool result's own fields (`isError: false` on a success); the earlier revisions stdio speaks add neither. `serverInfo` is the options' `name`, `version`, `description`, `websiteUrl` and `icons`, as given, so a 2026-07-28 result's encoded size is the size of its own fields plus a fixed overhead per endpoint or subprocess.
- Invalid arguments are answered by the native `McpServer`: from 2025-11-25 on, an `isError` result with a message for the model, such as `Invalid parameters for tool 'greet': Expected string\n  at ["name"]`; on earlier stdio revisions, a JSON-RPC error. HTTP's `InvalidInput` does not apply. A protected tool's call from a caller without a credential that verifies gets the 401 first, before its arguments are decoded, malformed ones included, on a mixed endpoint as on one of protected tools alone.
- Defects and encoding failures produce the generic `isError` text `Tool execution failed due to an internal server error.`; the cause is logged, not sent.
- Every caller sees every tool of the endpoint ([guarantees.md](guarantees.md#scope)); authorization happens in each implementation's `authorize`.
- Cancellation is Effect's native RPC interruption. Over HTTP there is no session, so `notifications/cancelled` interrupts nothing. A tool call ends with its HTTP request, whose lifetime (for example, whether a client disconnect interrupts it) is the host's.
- Handlers may yield `McpSchema.McpRequestContext` for the client's declared information; the native server supplies it to every tool call, so it is never a router or host requirement.
- `runStdio` is the subprocess's whole program: it serves until the host closes stdin, then succeeds, so the process exits 0. Closing stdin ends the input, not the calls in flight: each runs to completion and is answered, and `runStdio` succeeds once every answer is written. A script piping requests may close stdin as soon as it has written them. A call that never completes keeps the process running: MCP hosts close stdin to shut a server down, and the MCP specification expects them to send `SIGTERM` when it does not exit in time. A signal interrupts it, as any program. Provide `Stdio` and its services to it and run it, `NodeRuntime.runMain`.
- stdio is a local surface and takes no `authentication`: the host supplies `Stdio` (`NodeStdio.layer`) and any request-time services explicitly around `runStdio`, the identity of every protected tool included, `Effect.provideService(CurrentActor, actor)`. Each implementation's `authorize` runs for its protected tools. Tool arguments never establish identity.
- `runStdio` gives its program a `Console` that writes every method through the `error` of the console it runs with, to stderr, since stdout carries the protocol: every console logger, the default one included, `Console.log`, and the counters, timers and group labels Node's console prints on stdout. A counter or a timer prints its label and its count or the milliseconds since it started, a group prints its label without indenting what follows, `table` prints its value as `log` does, `dir` takes no options, and `clear` does nothing. A timer started again while it runs keeps its first start. Layers provided around `runStdio` run outside its program: apply `ActionCli.logToStderr` last, before `runMain`, as the example does, which moves their default logger to stderr and reports there what `runMain` would report on stdout, a failure of such a layer or a defect, with the exit code `runMain` gives ([ActionCli.md](ActionCli.md#rules)). It does not move their `Console` output or a logger writing through `Console.log`, such as `Logger.consoleJson`; log JSON with `Logger.withConsoleError(Logger.formatJson)` instead. Keep the global `console.log` and other direct writes off stdout.
- Each endpoint or subprocess owns a fresh native tool registry. That isolates tool names, not application context.
- Every tool declares the built-in errors ([guarantees.md](guarantees.md#wire-behavior)). An authorizer's refusal is an `isError` result whose text is its JSON, `{"_tag":"Forbidden","message":"Not allowed."}`, exactly like an action's own error.
- The authorizer runs after the native server decodes the tool's arguments.
- On an endpoint naming a Bearer descriptor, a protected tool's step-up refusal is an HTTP 401 or 403 instead of a tool result ([guarantees.md](guarantees.md#authorization)); a public tool's is its `isError` result, signed in or not; without one, or under a descriptor of another scheme, a tool's refusal is an `isError` tool result, and only the authentication's own refusal is a 401 or 403. On a `Forbidden`'s `insufficient_scope` challenge, an MCP client re-authorizes with those scopes and retries.
- That holds only while nothing of the response has been sent. Once a handler's notification, such as progress, has started a 200 event stream, a later refusal is the tool's `isError` result in it. An authorizer runs before its handler, so its refusal is always the status.
- Authentication refuses before the MCP handler too: an HTTP 401 or 403. An MCP client reads the 401's `WWW-Authenticate` challenge and finds its authorization server through the discovery `Authentication.layer` publishes for a protected resource ([Authentication.md](Authentication.md)).

## Failure modes

- `MCP tool input must be one object with keys, such as a struct: <name>, ...` thrown by `layerHttp` or `runStdio`: those actions' input is a union, an array, a scalar, or an object without keys such as `Schema.Struct({})`. Wrap a union in a field, `input: { notification: Schema.Union([Email, Sms]) }`, omit `input` (or give `{}`) for no arguments, or leave the action out of `actions`.
- `MCP media must be the success or an array of it, or a top-level field of a struct success, one, optional or a required array: <name>, ...` thrown by `layerHttp` or `runStdio`: those actions hold an `Action.Image` a tool cannot lift, nested in a field, in a union or a record, in an optional array field, in a class or an encoded struct, with an encoding of its own, in the input or in an error. Make it a top-level field of a `Schema.Struct` success, the whole success or an array of it, give an optional array field as a required one, empty when absent, or leave the action out of `actions`; the other surfaces send it as JSON.
- `Type 'CurrentActor' is not assignable to type 'never'` where the server is launched, with `CurrentActor` among the endpoint's startup requirements rather than its `Request<"Requires", ...>`: a feature reads a request service, which it never receives ([native features](#native-features)). Serve that content as an action.
- A native `McpServer.resource`, `McpServer.prompt` or `McpServer.toolkit` layer merged beside `layerHttp` builds without error and is never served: `resources/list` is empty, `prompts/list` is not found, and `tools/list` lists only the actions. Each endpoint's registry is its own: pass them as its `features`.
- An MCP client gets an `isError` refusal instead of the 401 or 403 it re-authorizes on: the handler sent a notification before refusing, so the response had already started. Refuse in the implementation's `authorize`, before the handler runs.
- `Duplicate MCP tool: <name>` thrown at the `layerHttp` or `runStdio` call: two implementations on one endpoint serve actions of the same name. Split the endpoint, or rename one action. `actions` tells apart only separate contracts sharing a name, listing one; two implementations of the same contract stay both listed: pass one implementation.
- `Duplicate MCP tool: <name>, claimed by an action and a native feature`, a defect when the endpoint builds: a native tool among its `features` has an action's name. Rename the native tool, or leave the action out of `actions`.
- `Listed in actions, but no implementation holds it: <names>` thrown at the `layerHttp` or `runStdio` call: those actions are not among the implementations' actions, by identity. `(another contract)` marks one whose name an implementation holds, as a second copy of the contracts module makes. Pass the implementation holding it, or list the contract it implements.
- `No overload matches this call` at `layerHttp`, ending `Type 'string' is not assignable to type 'never'` on its options: the endpoint serves a protected action and names no `authentication`, or one of another identity. Give its descriptor. `Protected action '<name>' requires its matching authentication descriptor` thrown by `layerHttp`: the same, from plain JavaScript.
- `Provider<CurrentActor, "example.Login">` among the endpoint's requirements, or `Type 'Provider<...>' is not assignable to type 'never'` where the server is launched: the descriptor's provider is not provided. `Layer.provide(authenticate)` on that `layerHttp` ([Authentication.md](Authentication.md#failure-modes)).
- `Type 'X' is not assignable to type 'never'` where the server is launched, or `Request<"Requires", X>` in the endpoint's type: a handler or an authorizer yields a request service that no middleware around the endpoint provides. Provide it with router middleware on that `layerHttp`; never an identity at startup. `X` the identity, on an endpoint serving public tools: a public handler reads it, which no public tool gets. Make that action protected.
- A public tool's call answers 401: it presented a credential that does not verify. Send a valid one, or none.
- A protected tool's call answers 401 to a signed-in host after a while: its token expired; the host refreshes it, or signs in again, on the challenge's `invalid_token`.
- A prompt or resource demands credentials: it is served on an endpoint naming a descriptor, where every feature request authenticates. Serve it on an endpoint without protected tools.
- A stdio program owes `CurrentActor`, `Type 'CurrentActor' is not assignable to type 'never'` at `runMain`: it serves a protected tool, whose caller the host supplies. Provide it around `runStdio`; stdio takes no `authentication`.
- Client reports a broken transport from a stdio subprocess: something wrote to stdout, such as `console.log`, or a layer provided around `runStdio` did, through the default logger without `Logger.LogToStderr` outermost, or through `Console` or a logger such as `Logger.consoleJson`, which `LogToStderr` does not move. Remove the write, apply `ActionCli.logToStderr` last, or log JSON with `Logger.withConsoleError(Logger.formatJson)`.
- A stdio host asking for 2025-03-26 or 2024-11-05 is offered 2025-11-25 in the `initialize` result, as MCP negotiates, and disconnects if it cannot speak it. Update the host.
- An MCP client cannot connect over HTTP: a request answers `400` with JSON-RPC error `-32020`. The client opens with `initialize`, as the 2025 revisions do, and HTTP serves only 2026-07-28. Pin the client to it (the official client: `versionNegotiation: { mode: { pin: "2026-07-28" } }`), or serve that host over stdio. Codex is such a client: it opens HTTP with `initialize` (measured on 0.159.0), so serve it over stdio.
- An Origin-bearing request reaches the native handler and gets an empty 403: its `Origin` is not in `allowedOrigins`. Add the exact origin only if the deployment trusts it.
- A disallowed Origin receives 401 instead: the endpoint's authentication rejected it before the native Origin check. A Host or Origin check that must run before authentication is global middleware ([Authentication.md](Authentication.md#rules)).
- Browser calls fail despite an allowed Origin: configure CORS outside authentication and the MCP handler (see the browser example above). The native allowlist alone neither handles preflight nor adds CORS response headers.
- `Object literal may only specify known properties, and 'protocols'`: the revisions are fixed. Delete the option.
