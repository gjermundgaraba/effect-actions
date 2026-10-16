# ActionMcp

MCP tools from implementations, on Effect's native `McpServer`: one tool per served action, named
after it. `layerHttp` mounts a Streamable HTTP endpoint, for clients that connect to a URL;
`runStdio` is the whole program of a subprocess a local agent starts. For a model your own code
calls in process, use [ActionToolkit.md](ActionToolkit.md).

Read this page alone, in one tool call; if its output says it was truncated, read it again alone.
When something fails, search [ActionMcp-failures.md](ActionMcp-failures.md). Reading order:
[README.md](README.md).

## API

Import `@gjermundgaraba/effect-actions/ActionMcp`.

| API                                   | Purpose                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `layerHttp(implementations, options)` | A Layer serving the actions as tools at one HTTP endpoint.  |
| `runStdio(implementations, options)`  | An Effect serving them on standard I/O until stdin closes.  |
| `Options`                             | Type of `runStdio`'s options.                               |
| `LayerHttpOptions`                    | Type of `layerHttp`'s options: `Options` and HTTP's own.    |
| `client(actions, options?)`           | An Effect of a client calling each action's tool.           |
| `request(method, params?, options?)`  | One MCP request, as the native `HttpClientRequest` to send. |
| `McpCallError`                        | A client method's undecodable answer, by tagged `reason`.   |

`implementations` is one implementation or a list.

| Option                               | Meaning                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `name`, `version`                    | Required server information.                                |
| `description`, `websiteUrl`, `icons` | Optional server information.                                |
| `instructions`                       | Optional text for the model about the server as a whole.    |
| `extensions`                         | Optional native capability extensions.                      |
| `actions`                            | The implementations' actions that are tools; default all.   |
| `features`                           | One Layer of native resources, prompts and tools to serve.  |
| `path`                               | HTTP only: the endpoint's path; defaults to `/mcp`.         |
| `allowedOrigins`                     | HTTP only: the exact origins allowed; none by default.      |
| `allowSubscriptions`                 | HTTP only: 2026-07-28 subscriptions; default if `features`. |
| `requestScoped`                      | HTTP only: `true` runs a server per request.                |
| `authentication`                     | HTTP only: the protected tools' authentication descriptor.  |

All but `actions`, `features`, `authentication` and `requestScoped` are Effect's own `McpServer`
options. Its `protocols` and `allowSessionTermination` are not options.

`client` takes `url`, default `/mcp`, `transformClient`, and the endpoint's `authentication`, so an
error its verifier declares decodes; `request` takes `url` and `headers`.
Types: `Client<Actions, D, E, R>`, `ClientOptions`, `RequestOptions`, `Params`.

## Serve tools over HTTP

Merge `layerHttp` into the routes, beside any other surface, and serve them with
`HttpRouter.serve`:

```ts
export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greeting),
  ActionMcp.layerHttp(greeting, { name: "greetings", version: "1.0.0" }),
);
```

See [quickstart/src/routes.ts](../examples/quickstart/src/routes.ts) and `server.ts` beside it.
Surfaces in one set of routes run each builder once, so a note written over HTTP is read as a
tool: [notes-service/src/routes.ts](../examples/notes-service/src/routes.ts). For two servers,
see [Action-in-process.md](Action-in-process.md#share-one-build-across-servers).

- The endpoint speaks MCP 2026-07-28, 2025-11-25 and 2025-06-18, as the client negotiates.
  Claude Code 2.1 and Codex CLI 0.162 connect (October 2026):
  `claude mcp add --transport http <name> <url>/mcp --header "Authorization: Bearer <token>"`,
  `codex mcp add <name> --url <url>/mcp --bearer-token-env-var <VAR>`;
  [mcp-tools](../examples/mcp-tools/README.md#connect-a-client) has stdio and Claude Desktop.
- **A client of a 2025 revision opens a session** with `initialize`; a 2026-07-28 request stands
  alone. A session holds what its client sent there and no identity: each request authenticates,
  as its own caller. It lasts until its client ends it with a `DELETE`, answered 204, or the process stops, as
  Effect expires none, so limit request bodies, which bounds what one holds. Where an endpoint
  serves a protected tool, only a signed-in caller opens one, and that client signs in for every
  request, a public tool's call included. An endpoint of public tools alone lets anyone open them.
- **On a serverless host**, such as Cloudflare Workers, pass `requestScoped: true`: a server per
  request, speaking 2026-07-28 alone with no session. Connect a client that opens with
  `initialize` to a long-lived endpoint: [notes-service/src/worker.ts](../examples/notes-service/src/worker.ts).
- An endpoint without `authentication` answers whoever reaches its port. Bind it to loopback or to
  a network only trusted clients are on, and limit request bodies
  ([ActionHttp.md](ActionHttp.md#serve-the-routes)):
  [mcp-tools/src/server.ts](../examples/mcp-tools/src/server.ts).
- The endpoint takes no layer middleware. A limit that must hold for tools goes in the handlers:
  [kitchen-sink/src/issues/write-limit.ts](../examples/kitchen-sink/src/issues/write-limit.ts).

## Serve tools over stdio

Provide `Stdio` and the startup services, then run it:

```ts
ActionMcp.runStdio([status, notes, identity], { name: "notes-service", version: "1.0.0" }).pipe(
  // DEMO ONLY: a real host reads who started it, from its own login or configuration.
  Effect.provideService(CurrentUser, users.ada),
  Effect.provide([NodeStdio.layer, NoteStore.layerMemory]),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
```

See [notes-service/src/stdio.ts](../examples/notes-service/src/stdio.ts), and
[mcp-tools/src/stdio.ts](../examples/mcp-tools/src/stdio.ts) for public tools.

To try a server by hand, send one request as `request` builds it, its 2026-07-28 metadata in
`_meta`: [mcp-tools](../examples/mcp-tools/README.md#connect-a-client) has the `curl`, with
HTTP's five headers, and [notes-service](../examples/notes-service/README.md#run-it) the stdio command.

- **stdout carries the protocol alone.** `runStdio` sends its own program's Effect logs and
  `Console` output to stderr. For the layers provided around it, apply `ActionCli.logToStderr`
  last, before `runMain`: it moves their default logger and reports a startup failure there too.
  Nothing moves the global `console.log`: keep it off stdout.
- **A subprocess has its own services.** It runs the handlers itself, so it shares a server's
  data only through a store both reach, never one in memory. A host that should see what the
  server holds connects to its HTTP endpoint.
- **No token arrives, so the host names the caller.** stdio takes no `authentication`: provide the
  protected tools' identity around `runStdio`, whose one caller is whoever started it. Each
  implementation's `authorize` still runs, so give that caller what it checks. Tools served
  behind a token over HTTP keep their one protected contract here: never a public copy.
- **Test the tools without a process**: [Testing.md](Testing.md#test-mcp-tools).

## Describe tools to a model

A tool is its contract ([Action.md](Action.md#define-a-contract)): a model knows only the action's
name, its `description`, and its input schema with each field's `description`. `readOnly` is the
tool's read-only hint, and the contract's `mcp` option holds its `title`, its other hints and its
`_meta`. The server's `instructions` say what the tools are for together. See
[mcp-tools/src/printers/Printers.ts](../examples/mcp-tools/src/printers/Printers.ts) and
[mcp-tools/src/instructions.ts](../examples/mcp-tools/src/instructions.ts).

- MCP takes a write as destructive unless it states `destructiveHint: false`: one that only adds.
- A tool's input is one object with keys. Omit `input` for a tool without arguments, and wrap a
  union, an array or a scalar in a field.
- An argument the schema refuses, an undeclared one included, is answered by the native server
  before the handler runs, as an `isError` result whose text is `Invalid parameters for tool
  '<name>': …`, not `InvalidInput`. So constrain in the schema
  what a model may send: an id written into an upstream URL is not made safe by
  `encodeURIComponent`, which leaves `..` alone.
- A `Schema.makeFilter` check adds nothing to the tool's listed input schema, and
  `Schema.isPattern` its `pattern` only for a RegExp with the `u` flag. Say such a rule in the
  field's `description`, annotated before the check: after a custom one it is lost too.
- A declared error reaches the model as an `isError` result whose text is the error's JSON. Write
  its `message` for the model, which acts on it:
  [mcp-tools/src/platform/print-farm.ts](../examples/mcp-tools/src/platform/print-farm.ts). Every other case:
  [guarantees.md](guarantees.md#wire-behavior).
- `actions` lists the tools, and only listed actions must suit MCP:
  [kitchen-sink/src/Actions.ts](../examples/kitchen-sink/src/Actions.ts). Leave out an action a
  model should not call, or one that takes a secret ([Action.md](Action.md#define-a-contract)).

## Return images and other media

Give the success an `Action.Image` field, the one media kind, and return its bytes and MIME type
from the handler:

```ts
success: { printer: Printer, image: Action.Image },
```

The tool sends the field as an image block, after the JSON of the rest. Every other surface sends
it as JSON, the bytes in base64. See
[mcp-tools/src/printers/Printers.ts](../examples/mcp-tools/src/printers/Printers.ts); `client`
decodes it back.

- An image is a top-level field of a struct success, bare, optional or a required array, or the
  whole success or an array of it. Anywhere else in a served action, as in a `Schema.NullOr`, a
  `Schema.Class` success or an input, `layerHttp` and `runStdio` throw. So an action taking an
  image as input is no tool: leave it out of `actions`
  ([kitchen-sink/src/attachments/Attachments.ts](../examples/kitchen-sink/src/attachments/Attachments.ts)).
- A media field's own `description` reaches no model. Describe the image in the action's
  `description`.

## Protect tools

Name the protected actions' authentication descriptor and provide its provider to the routes:

```ts
const mcp = ActionMcp.layerHttp(implementations, {
  name: "notes-service",
  version: "1.0.0",
  authentication: Login,
});

export const routes = Layer.mergeAll(api, mcp, health, openApi).pipe(Layer.provide(authenticate));
```

See [notes-service/src/routes.ts](../examples/notes-service/src/routes.ts). Write the
[descriptor](Authentication.md#declare-how-callers-sign-in) and its
[provider](Authentication.md#verify-credentials) once for every surface, and
[publish discovery](Authentication.md#publish-oauth-discovery) so an MCP client finds where to
sign in. What a signed-in caller may do is each implementation's
[`authorize`](Action.md#authorize-calls), which runs on every call of a protected tool.

- **One endpoint or two.** An endpoint of protected tools alone authenticates every request,
  the listing included. On a mixed endpoint, serving public and protected tools, a 2026-07-28
  request lists every tool, protected ones included, and calls a public one signed out, and a
  session's every request signs in ([Serve tools over HTTP](#serve-tools-over-http)). A
  protected tool's call answers the 401 a client signs in on. To keep protected tools unlisted
  to signed-out callers, or public ones open to a session's client, serve the public tools on an
  endpoint of their own: a second `layerHttp` on another `path`.
- No listing is filtered by caller: `authorize` refuses the call, not the sight of the tool.
- On a Bearer endpoint, a protected tool's step-up refusal answers the request, not a tool
  result ([Authentication.md](Authentication.md#step-up-for-a-scope),
  [guarantees.md](guarantees.md#wire-behavior)). Once a handler has sent a notification the
  response has started, and its refusal is a tool result: refuse in `authorize`.
- Test as a signed-in caller ([Testing.md](Testing.md#test-as-a-signed-in-caller)):
  [notes-service/test/routes.test.ts](../examples/notes-service/test/routes.test.ts).

## Allow browser clients

A browser MCP client sends its page's `Origin`, and needs two things.

- **`allowedOrigins`.** A request carrying an `Origin` is refused with 403 unless that exact
  origin is listed, so a page a user visits cannot call the tools; one without, as other
  clients send, passes. Authentication runs first, so the verifier sees a token from any origin:
  a request that must authenticate, or sends a token, gets 401 without a valid one. Read the
  list from config: [mcp-tools/src/routes.ts](../examples/mcp-tools/src/routes.ts).
- **CORS.** `allowedOrigins` only refuses: it answers no preflight and adds no header. Add
  `HttpRouter.cors`, global to the router, only where an origin is configured: given an empty
  list, it answers `Access-Control-Allow-Origin: *`, and given one origin it names that origin
  to every request, an unlisted page's included, which `allowedOrigins` still refuses. Allow the methods `POST` and
  `DELETE`, the endpoint's only ones, and the headers `Content-Type`, `Authorization`,
  `MCP-Protocol-Version`, `MCP-Method`, `MCP-Name` and `Mcp-Session-Id`; expose
  `WWW-Authenticate`, `MCP-Protocol-Version` and `Mcp-Session-Id`: the same `routes.ts`, and
  [kitchen-sink/src/request-policy.ts](../examples/kitchen-sink/src/request-policy.ts) with
  authentication.

A `Host` allowlist, for a request that sends no `Origin`, or an Origin check that must run first
is a request policy:
[Authentication-advanced.md](Authentication-advanced.md#run-a-request-policy-before-authentication).

## Add native prompts and resources

Merge Effect's own `McpServer.resource`, `McpServer.prompt` and `McpServer.toolkit` layers into
one and pass it as `features`:
[kitchen-sink/src/issues/guide.ts](../examples/kitchen-sink/src/issues/guide.ts), given in
[kitchen-sink/src/routes.ts](../examples/kitchen-sink/src/routes.ts) and
[kitchen-sink/src/stdio.ts](../examples/kitchen-sink/src/stdio.ts). Provide a service they need
around the endpoint, never to the `features` layer itself: there it is built again for the
features alone, so a resource reads another store than the tools write.

- No `authorize` runs for them, and they run with the services they were built with, never a
  request's, so they cannot read the caller. Content that depends on the caller is an action.
- On an endpoint naming `authentication`, every prompt and resource request needs a credential,
  listings included. To offer them to signed-out callers, serve them on an endpoint without
  protected tools.

## Send notifications from a handler

A handler yields `McpServer.McpServer` and sends through it:
`server.notifications["notifications/progress"]({ progressToken, progress })`.
`McpSchema.McpRequestContext` holds what the client sent: its `clientInfo`, and the request's
`_meta` as `requestMetadata`. The endpoint and `runStdio` provide both; an implementation also
served on another surface reads them with `Effect.serviceOption`.

- On 2026-07-28, a progress notification is sent only with the token its request carried,
  `requestMetadata?.progressToken`. With another, or when the client sent none, it is dropped
  silently.
