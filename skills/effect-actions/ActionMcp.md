# ActionMcp

MCP tools from implementations, on Effect's native `McpServer`: one tool per served action, named
after it. Reach for it to put actions in front of a model that connects from outside your process.
`layerHttp` mounts a Streamable HTTP endpoint on the router, for clients that connect to a URL;
`runStdio` is the whole program of a subprocess a local agent starts. For a model your own code
calls in process, use [ActionToolkit.md](ActionToolkit.md).

## API

Import `@gjermundgaraba/effect-actions/ActionMcp`.

| API                                   | Purpose                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `layerHttp(implementations, options)` | A Layer serving the implementations' actions as tools at one Streamable HTTP endpoint.            |
| `runStdio(implementations, options)`  | An Effect serving them on standard I/O, a subprocess's whole program; succeeds when stdin closes. |
| `Options`                             | Type of `runStdio`'s options.                                                                     |
| `LayerHttpOptions`                    | Type of `layerHttp`'s options: `Options` and the three HTTP ones.                                 |

`implementations` is one implementation or a list.

| Option                               | Meaning                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `name`, `version`                    | Required server information.                                                              |
| `description`, `websiteUrl`, `icons` | Optional server information, sent to clients with `name` and `version`.                   |
| `instructions`                       | Optional text for the model about the server as a whole.                                  |
| `extensions`                         | Optional native capability extensions.                                                    |
| `actions`                            | The actions that are tools, among the implementations'; defaults to all.                  |
| `features`                           | One Layer of native resources, prompts and tools served beside the actions' tools.        |
| `path`                               | `layerHttp` only: the endpoint's path; defaults to `/mcp`.                                |
| `allowedOrigins`                     | `layerHttp` only: the exact `Origin` values a request may carry; none by default.         |
| `authentication`                     | `layerHttp` only: the protected tools' authentication descriptor; required to serve them. |

All but `actions`, `features` and `authentication` are Effect's own `McpServer` options, passed
through. Its `protocols` and `allowSessionTermination` are not options: the revisions are fixed,
and a client may always end its session.

## Serve tools over HTTP

Merge `layerHttp` into the routes, beside any other surface, and serve them with
`HttpRouter.serve`:

```ts
export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greeting),
  ActionMcp.layerHttp(greeting, { name: "greetings", version: "1.0.0" }),
);
```

See [quickstart/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/routes.ts) and
[quickstart/src/server.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/server.ts). Surfaces given the same
implementations in one set of routes run each builder once, so a note written over HTTP is read
as a tool: [notes-service/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/routes.ts). For two
servers, see [Action.md](Action.md#share-one-build-across-servers).

- The endpoint speaks MCP 2026-07-28, 2025-11-25 and 2025-06-18, as the client negotiates.
  Claude Code 2.1 and Codex CLI 0.162 both connect, as tested in October 2026:
  [notes-service](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/README.md#run-it) has the commands.
- **A client of a 2025 revision opens a session** with `initialize`; a 2026-07-28 request stands
  alone. A session holds what its client sent there and no identity: each request authenticates,
  as its own caller. It lasts until its client ends it with a `DELETE` or the process stops, as
  Effect expires none, so limit request bodies, which bounds what one holds. Where an endpoint
  serves a protected tool, only a signed-in caller opens one, and that client signs in for every
  request, a public tool's call included. An endpoint of public tools alone lets anyone open them.
- An endpoint without `authentication` answers whoever reaches its port. Bind it to loopback or to
  a network only trusted clients are on, and limit request bodies
  ([ActionHttp.md](ActionHttp.md#serve-the-routes)):
  [mcp-tools/src/server.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/server.ts).
- The endpoint takes no layer middleware, which `ActionHttp.layer` and `ActionRpc.layer` do. A
  limit that must hold for tools goes in the handlers, where it holds on every surface:
  [kitchen-sink/src/issues/write-limit.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/issues/write-limit.ts).

## Serve tools over stdio

`runStdio` is the program of an MCP subprocess. Provide `Stdio` and the startup services, then run
it:

```ts
ActionMcp.runStdio([status, notes, identity], { name: "notes-service", version: "1.0.0" }).pipe(
  // DEMO ONLY: a real host reads who started it, from its own login or configuration.
  Effect.provideService(CurrentUser, users.ada),
  Effect.provide([NodeStdio.layer, NoteStore.layerMemory]),
  // stdout carries the protocol alone, so logs and failures go to stderr.
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
```

See [notes-service/src/stdio.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/stdio.ts), and
[mcp-tools/src/stdio.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/stdio.ts) for public tools. It serves until the
host closes stdin and every call in flight is answered, then succeeds. `actions` and `features`
work as over HTTP.

To try a server by hand, pipe it one request. Without an `initialize` handshake before it, a
request carries the 2026-07-28 metadata in its `_meta`, as the body `Testing.mcpRequest` builds
does:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"getStatus","arguments":{},"_meta":{"io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}' |
  node --import tsx examples/notes-service/src/stdio.ts
```

- **stdout carries the protocol alone.** `runStdio` sends its own program's Effect logs and
  `Console` output to stderr. Layers provided around it run outside that program: apply
  `ActionCli.logToStderr` last, before `runMain`, which moves their default logger and reports a
  startup failure there too. Nothing moves the global `console.log`: keep it off stdout.
- **A subprocess has its own services.** It runs the handlers itself, with the layers it is
  given, so it shares a server's data only through a store both reach, never one in memory. A
  host that should see what the server holds connects to its HTTP endpoint.
- **No token arrives, so the host names the caller.** stdio takes no `authentication`: provide the
  protected tools' identity around `runStdio`. Each implementation's `authorize` still runs. A
  subprocess has one caller, whoever started it. An HTTP server has many: never provide an
  identity at its startup, where it would stand for every request.

## Describe tools to a model

A tool is its contract ([Action.md](Action.md#define-a-contract)): the action's name, its
`description`, and its input schema with each field's `description` are all a model knows of it.
`readOnly` is the tool's read-only hint, and the contract's `mcp` option holds its `title`, its
other hints and its `_meta`. The server's `instructions` say what the tools are for together. See
[mcp-tools/src/printers/Printers.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/printers/Printers.ts) and
[mcp-tools/src/instructions.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/instructions.ts).

- MCP takes a write as destructive unless it states `destructiveHint: false`.
- A tool's input is one object with keys. Omit `input` for a tool without arguments, and wrap a
  union, an array or a scalar in a field.
- An argument the schema refuses, an undeclared one included, is answered by the native server
  before the handler runs, with its own message, not `InvalidInput`. So constrain in the schema
  what a model may send: an id written into an upstream URL is not made safe by
  `encodeURIComponent`, which leaves `..` alone.
- A declared error reaches the model as an `isError` result whose text is the error's JSON. Write
  its `message` for the model, which acts on it:
  [mcp-tools/src/printers/farm.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/printers/farm.ts). A defect answers a
  generic text, its cause logged and not sent. Every case:
  [guarantees.md](guarantees.md#wire-behavior).
- `actions` lists the tools, and only listed actions must suit MCP:
  [kitchen-sink/src/Actions.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/Actions.ts). Leave out an action a
  model should not call, or one that takes a secret ([Action.md](Action.md#define-a-contract)).

## Return images and other media

Give the success an `Action.Image` field, the one media kind, and return its bytes and MIME type
from the handler:

```ts
success: { printer: Printer, image: Action.Image },
```

The tool sends the field as an image block, which the model sees as an image, after the JSON of
the rest. Every other surface sends it as JSON, the bytes in base64. See
[mcp-tools/src/printers/Printers.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/printers/Printers.ts), and
[Testing.md](Testing.md#test-mcp-tools) for the client that decodes it back.

- An image is a top-level field of a struct success, bare, optional or a required array, or the
  whole success or an array of it. Anywhere else in a served action, `layerHttp` and `runStdio`
  throw: nested, in a union such as `Schema.NullOr`, in a `Schema.Class` success, in an error, or
  in the input.
- So an action taking an image as input is no tool: leave it out of `actions`
  ([kitchen-sink/src/attachments/Attachments.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/attachments/Attachments.ts)).
- A media field's own `description` reaches no model. Describe the image in the action's
  `description`.

## Protect tools

Name the protected actions' authentication descriptor and provide its provider to the routes:

```ts
const mcp = ActionMcp.layerHttp(implementations, {
  name: "notes-service",
  version: "1.0.0",
  instructions: "Notes belong to the signed-in user. Read a note before updating it.",
  authentication: Login,
});

export const routes = Layer.mergeAll(api, mcp, health, openApi).pipe(Layer.provide(authenticate));
```

See [notes-service/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/routes.ts). Write the
[descriptor](Authentication.md#declare-how-callers-sign-in) and its
[provider](Authentication.md#verify-credentials) once for every surface, and
[publish discovery](Authentication.md#publish-oauth-discovery) so an MCP client finds where to
sign in. What a signed-in caller may do is each implementation's
[`authorize`](Action.md#authorize-calls), which runs on every call of a protected tool.

- **One endpoint or two.** On a mixed endpoint, serving public and protected tools, anyone lists
  every tool, protected ones included, and calls the public ones; a protected tool's call answers
  the 401 a client signs in on. To keep protected tools unlisted to signed-out callers, serve the
  public tools on an endpoint of their own: a second `layerHttp` on another `path`. An endpoint of
  protected tools alone authenticates every request, the listing included.
- The listing is never filtered by caller: `authorize` refuses the call, not the sight of the
  tool.
- On a Bearer endpoint, a protected tool's `Unauthenticated`, or `Forbidden` naming `scopes`,
  answers the request with 401 or 403 and a challenge the client acts on, in place of a tool
  result ([Authentication.md](Authentication.md#publish-oauth-discovery)). Once a handler has sent a notification the
  response has started, and its refusal is a tool result: refuse in `authorize`.

## Allow browser clients

A browser MCP client sends its page's `Origin`, and needs two things.

- **`allowedOrigins`.** A request carrying an `Origin` is refused with 403 unless that exact
  origin is listed, and none is by default. A request without one, as other clients send, passes.
  Read the list from configuration:
  [mcp-tools/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/routes.ts).
- **CORS.** `allowedOrigins` only refuses: it answers no preflight and adds no header. Add
  `HttpRouter.cors`, global to the router, so it answers the preflight before authentication and
  adds its headers to refusals, with the headers an MCP client sends and reads:
  [kitchen-sink/src/request-policy.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/request-policy.ts), provided
  in [kitchen-sink/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/routes.ts). Its policy covers every
  route of the router.

The endpoint's authentication runs before its Origin check, so `allowedOrigins` keeps no request
from the verifier. A Host or Origin check that must run first is a request policy:
[Authentication.md](Authentication.md#run-a-request-policy-before-authentication).

## Add native prompts and resources

Merge Effect's own `McpServer.resource`, `McpServer.prompt` and `McpServer.toolkit` layers into
one and pass it as `features`, to `layerHttp` or `runStdio`:
[kitchen-sink/src/issues/guide.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/issues/guide.ts), given in
[kitchen-sink/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/routes.ts) and
[kitchen-sink/src/stdio.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/stdio.ts). Provide a service they need
around the endpoint, never to the `features` layer itself: there it is built again for the
features alone, so a resource reads another store than the tools write.

- Merged beside the endpoint, not given as `features`, they build without error and are never
  served.
- They are native, not actions: no `authorize` runs for them, and they run with the services they
  were built with, never a request's, so they cannot read the caller. Content that depends on the
  caller is an action.
- On an endpoint naming `authentication`, every prompt and resource request needs a credential,
  listings included. To offer them to signed-out callers, serve them on an endpoint without
  protected tools.

## Send notifications from a handler

A handler yields `McpServer.McpServer` and sends through it:
`server.notifications["notifications/progress"]({ progressToken, progress })`.
`McpSchema.McpRequestContext` holds what the client sent: its `clientInfo`, and the request's
`_meta` as `requestMetadata`. The endpoint and `runStdio` provide both, so no host owes them. An
implementation also served on another surface, where nothing provides them, reads them with
`Effect.serviceOption`.

- On 2026-07-28, a progress notification is sent only with the token
  its request carried, `requestMetadata?.progressToken`. With another token, or when the client
  sent none, it is dropped silently.
- A notification starts the response, so a refusal after it is a tool result, not a 401 or 403:
  refuse in `authorize` ([Protect tools](#protect-tools)).

## Examples

| File                                                                                                   | Shows                                                                          |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [quickstart/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/routes.ts)                                       | One public tool beside a JSON route.                                           |
| [notes-service/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/routes.ts)                                 | Public and protected tools on one endpoint, beside a JSON API.                 |
| [notes-service/src/identity/verifier.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/identity/verifier.ts)           | The provider, and the discovery an MCP client signs in through.                |
| [notes-service/src/stdio.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/stdio.ts)                                   | A stdio server whose host names the caller.                                    |
| [notes-service/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/test/routes.test.ts)                     | Tools called in memory as a signed-in caller; the listing to a signed-out one. |
| [mcp-tools/src/printers/Printers.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/printers/Printers.ts)                   | Descriptions, hints and titles; an id constrained by its schema; an image.     |
| [mcp-tools/src/printers/farm.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/printers/farm.ts)                           | An upstream's failures as one declared error a model can act on.               |
| [mcp-tools/src/instructions.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/instructions.ts)                             | Server information and `instructions`, shared by both transports.              |
| [mcp-tools/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/routes.ts)                                         | `allowedOrigins` from configuration.                                           |
| [mcp-tools/src/server.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/server.ts)                                         | A body limit, and where an unauthenticated server binds.                       |
| [mcp-tools/src/stdio.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/src/stdio.ts)                                           | A stdio server of public tools, its logs on stderr.                            |
| [mcp-tools/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/test/routes.test.ts)                             | Listed hints, an image, a declared error and the origin check, in memory.      |
| [kitchen-sink/src/Actions.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/Actions.ts)                                 | `actions`: one action left off the tools.                                      |
| [kitchen-sink/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/routes.ts)                                   | A mixed endpoint with `actions`, `features` and `allowedOrigins`, and CORS.    |
| [kitchen-sink/src/request-policy.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/request-policy.ts)                   | CORS for a browser MCP client.                                                 |
| [kitchen-sink/src/issues/guide.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/issues/guide.ts)                       | A native resource and prompt as `features`.                                    |
| [kitchen-sink/src/stdio.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/stdio.ts)                                     | A stdio server with `actions` and `features`.                                  |
| [kitchen-sink/src/attachments/Attachments.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/attachments/Attachments.ts) | An image in a success, a tool, and in an input, no tool.                       |
| [kitchen-sink/test/identity/identity.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/identity.test.ts) | Discovery, a 401's challenge, and a verifier's declared error over MCP.        |

## Failure modes

- `MCP tool input must be one object with keys, such as a struct: <name>, ...` thrown by `layerHttp` or `runStdio`: those actions' input is a union, an array, a scalar, or an object without keys such as `Schema.Struct({})`. Wrap it in a field, `input: { notification: Schema.Union([Email, Sms]) }`, omit `input` for no arguments, or leave the action out of `actions`.
- `MCP media must be the success or an array of it, or a top-level field of a struct success, one, optional or a required array: <name>, ...` thrown by `layerHttp` or `runStdio`: those actions hold an `Action.Image` no tool can send as a block ([media](#return-images-and-other-media)). Make it a top-level field of a `Schema.Struct` success, give an optional array as a required one, empty when absent, or leave the action out of `actions`.
- `Duplicate MCP tool: <name>` thrown by `layerHttp` or `runStdio`: two implementations serve actions of one name. Split the endpoint or rename one. `actions` tells apart only separate contracts sharing a name; of two implementations of one contract, pass one.
- `Duplicate MCP tool: <name>, claimed by an action and a native feature`, a defect when the endpoint builds: a native tool among `features` has an action's name. Rename it, or leave the action out of `actions`.
- `Listed in actions, but no implementation holds it: <names>` thrown by `layerHttp` or `runStdio`: those actions are not among the implementations', by identity. `(another contract)` marks one whose name an implementation holds, as a second copy of the contracts module makes. Pass the implementation holding it, or list the contract it implements.
- `Property 'authentication' is missing` on `layerHttp`'s options: the endpoint serves a protected action and names no descriptor. `Type 'Other' is not assignable to type 'CurrentUser'` on `authentication`: the descriptor is another identity's. `Protected action '<name>' requires its matching authentication descriptor` thrown by `layerHttp`: either, from plain JavaScript. Give the protected actions' descriptor.
- `Provider<CurrentUser, "notes-service.Login">` among the endpoint's requirements, or `Type 'Provider<...>' is not assignable to type 'never'` where the server is launched: the descriptor's provider is not provided. `Layer.provide(authenticate)` on the routes ([Authentication.md](Authentication.md#failure-modes)).
- `Type 'X' is not assignable to type 'never'` where the server is launched, or `Request<"Requires", X>` in the endpoint's type: a handler or an authorizer yields a request service no middleware around the endpoint provides. Provide it with router middleware; never an identity at startup. `X` the identity, on an endpoint serving public tools: a public handler reads it, which no public tool gets, signed in or not. Make that action protected.
- `Type 'CurrentUser' is not assignable to type 'never'` where the server is launched, with `CurrentUser` among the endpoint's startup requirements, not its `Request<"Requires", ...>`: a feature reads a request service, which it never receives ([features](#add-native-prompts-and-resources)). Serve that content as an action.
- `Type 'CurrentUser' is not assignable to type 'never'` at a stdio program's `runMain`: it serves a protected tool, whose caller the host supplies. Provide it around `runStdio`.
- `Object literal may only specify known properties, and 'protocols'`: the revisions are fixed. Delete the option.
- A native resource, prompt or toolkit layer is never served: `resources/list` is empty, `prompts/list` is not found, `tools/list` lists only the actions. It is merged beside the endpoint. Pass it as `features`.
- A prompt or resource demands credentials: its endpoint names a descriptor. Serve it on an endpoint without protected tools.
- A public tool's call answers 401: it presented a credential that does not verify. Send a valid one, or none.
- A protected tool's call answers 401 to a signed-in client after a while: its token expired. The client refreshes it, or signs in again, on the challenge's `invalid_token`.
- An MCP client gets an `isError` refusal, not the 401 or 403 it re-authorizes on: the handler sent a notification before refusing. Refuse in `authorize`.
- A client that opens with `initialize` gets 401 where it lists the tools or calls a public one, on an endpoint that also serves protected tools: a session's every request authenticates. Sign the client in, or serve the public tools on an endpoint of their own.
- A request over HTTP answers 400, `MCP-Session-Id header is required; send initialize to start a session`: it is of a 2025 revision and follows no `initialize`. One answering 404 names a session that ended, or one of a process since restarted: the client opens another.
- A request written by hand over HTTP answers 400 with JSON-RPC error `-32602`, `Required request metadata is missing`: it names 2026-07-28 in `MCP-Protocol-Version` and lacks that revision's `_meta` or routing headers. Build it with `Testing.mcpRequest`.
- A client asking for 2025-03-26 or 2024-11-05 is offered 2025-11-25, and disconnects if it cannot speak it: HTTP and stdio serve 2026-07-28, 2025-11-25 and 2025-06-18. Update the client.
- A request written by hand to a stdio server answers JSON-RPC error `-32602`, `Invalid request metadata`: it is neither preceded by `initialize` nor carries the 2026-07-28 metadata. Open with `initialize` and `notifications/initialized`, or give the request's `_meta` its `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` ([stdio](#serve-tools-over-stdio)).
- A client reports a broken transport from a stdio subprocess: something wrote to stdout. The global `console.log` did, or a layer provided around `runStdio` did, through the default logger, or through `Console` or a logger such as `Logger.consoleJson`, which `logToStderr` does not move. Remove the write, apply `ActionCli.logToStderr` last, or log JSON with `Logger.withConsoleError(Logger.formatJson)`.
- A request carrying an `Origin` gets an empty 403: the origin is not in `allowedOrigins`. Add the exact origin, only if the deployment trusts it.
- A disallowed `Origin` gets 401, not 403: the endpoint's authentication refused it before the Origin check ([browser clients](#allow-browser-clients)).
- Browser calls fail despite an allowed origin, the preflight answering 405: there is no CORS. Add `HttpRouter.cors` ([browser clients](#allow-browser-clients)).
- `Tool <name> has an output schema but did not return structured content` raised by a Python MCP client for an action that returns nothing: its success is sent as `null`, which a Python SDK release before the fix of python-sdk#3345 reads as missing. Update the SDK.
