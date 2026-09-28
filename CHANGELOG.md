# Changelog

## 0.8.0

One contract, one `implement`, one binding, one hook. `ActionGroup` is gone: actions are
implemented directly, HTTP binds a flat list of actions, and every client calls an action with
its input. An implementation carries its `before` hook, which every surface runs. The library
owns the failures a surface answers with: `InvalidInput` (400), `Unauthenticated` (401) and
`Forbidden` (403). CLI flags come from each action's input. Clients and `Testing` are
Effect-only, the client modules merge into `ActionHttp` and `ActionCli`, and `ActionCatalog` is
removed.

### Breaking changes

```ts
// 0.7.0
const Users = ActionGroup.make({ name: "users" }, GetUser, RenameUser);
const users = Users.implement(build);
const Http = ActionHttp.make({ apiPath: "/api", errors }, Users);
Http.layer([users], { before: authorize });

// 0.8.0
const users = Action.implement([GetUser, RenameUser], build, authorize);
const Http = ActionHttp.make([GetUser, RenameUser]);
ActionHttp.layer(Http, users);
```

| 0.7.0                                                            | 0.8.0                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ActionGroup.make(...)`, `Group.implement(build)`                | `Action.implement(actions, build)`                                                                    |
| A group's `errors`                                               | `ActionHttp.make(actions, { errors })` for middleware's; an action's `errors` for its handler's       |
| `mcp: { ... }`, `action.mcp`, `Action.McpOptions`                | `hints: { ... }`, `action.hints`                                                                      |
| `mcp.name`                                                       | The action's name, which is the tool's                                                                |
| `mcp: false`                                                     | Leave the implementation out of `ActionMcp` and `ActionToolkit`                                       |
| `hints.readOnly`                                                 | `access: "read"`                                                                                      |
| `ActionHttp.make({ apiPath, errors, schemaError, name }, Group)` | `ActionHttp.make(actions, { prefix? })`: `prefix: "/api/users"` keeps `/api/users/getUser`            |
| `Http.layer(implementations, { before })`                        | `ActionHttp.layer(Http, implementations)`                                                             |
| `Http.openApi()`                                                 | `HttpRouter.add("GET", path, HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)))`               |
| `errors`, `schemaError`, `SchemaErrorPolicy` on any surface      | The built-in `Action.InvalidInput`, `Action.Unauthenticated` and `Action.Forbidden`                   |
| `before` on any surface, `ActionToolkit.make`'s second argument  | `Action.implement(actions, handlers, before)`                                                         |
| A hook failing with an application error                         | A hook failing with `Action.Refusal`, `Unauthenticated` or `Forbidden`                                |
| `Authentication.middleware(tag, authenticate, options).layer`    | `Authentication.make(tag, authenticate, resource?)`, provided as it is                                |
| `Authentication.protectedResource`, `challenge()`                | `make`'s third argument, which publishes discovery and names it in every challenge                    |
| A 401 challenge naming a scope                                   | `scopesRequired` in `make`'s third argument                                                           |
| A refusal built by hand outside the router                       | `Authentication.refusal(error, protectedResource?, authorization?)`                                   |
| An `InsufficientScope` error and a hand-built challenge          | `new Action.Forbidden({ message, scopes: [scope] })`                                                  |
| `bearerToken` succeeding with an `Option`                        | `bearerToken` failing with `Unauthenticated`; `Effect.option(bearerToken)` where it is optional       |
| `bearerToken` succeeding with a `string`                         | A `Redacted<string>`; `Redacted.value(token)` where it is verified                                    |
| The `ActionHttp.Http` type                                       | `ActionHttp.Binding`                                                                                  |
| `ActionHttpClient.make`, `ActionHttpClient.Client`               | `ActionHttp.client`, `ActionHttp.Client`                                                              |
| `ActionHttpClient.promise`                                       | A client built once with `FetchHttpClient.layer`, each call `Effect.runPromise`d (ActionHttp.md)      |
| `client.getUser({ payload })`                                    | `client.getUser(input)`                                                                               |
| `ActionCliClient.command(Http, A, { connection: { baseUrl } })`  | `ActionCli.command(Http, A)` on a host `HttpClient` that prepends the URL                             |
| `ActionCli.command(app, "name")`, `ActionCli.group(app)`         | `ActionCli.command(implementations, Action)`, `ActionCli.make(implementations, { name })`             |
| `parameters`, the `input` mapper, `--input-file`                 | Flags from the input: `--tenant-id acme`; `--input "$(cat x.json)"` for an input that is not a struct |
| `Testing.serve`, `Testing.httpClient`, `TestingClient`           | `Testing.layer(routes)`, an in-memory `HttpClient` for every client                                   |
| `Testing.mcpCall(server, { name, arguments })`                   | `Testing.mcpClient(actions, { url?, transformClient? })`, then `mcp.<action>(input)`                  |
| `ActionCatalog`                                                  | `OpenApi.fromApi(Http.api)`, or an MCP endpoint's `tools/list`                                        |
| `ActionMcp.Options` of `layerHttp`                               | `ActionMcp.LayerHttpOptions`; `ActionMcp.Options` is the server's, which both functions take          |
| `Layer.launch(ActionMcp.layerStdio(implementations, options))`   | `ActionMcp.runStdio(implementations, options)`, which succeeds when the host closes stdin             |
| `Logger.LogToStderr` provided to an stdio server                 | Nothing: `runStdio` sends Effect logs to stderr                                                       |
| Span `<group>.<action>`, attribute `action.group`                | Span `<action>`                                                                                       |

Behavior that changes without a rename:

- A record has exactly one handler per action: an extra key is a compile error, which 0.7.0
  ignored. `implement` throws `Missing handlers: <names>` or `Unknown handlers: <keys>`; a
  builder's record is checked when its layer builds.
- A builder runs once per host build, however many surfaces serve it; 0.7.0 ran it once per
  adapter layer. Provide its startup services once, above every surface. `ActionCli` still runs
  it per invocation.
- Routes are `POST <prefix>/<action>`, `/api` by default, with operation ID `<action>`, so
  action names are unique per binding. The OpenAPI tag is the mount path, such as `api/users`,
  or `/` at the root.
- Every endpoint declares its action's errors, its binding's, and the three built-in ones, and
  every tool the two refusals. Input that does not decode, malformed JSON included, is a 400
  `InvalidInput` carrying the schema's message. A result that does not encode is an empty 500.
- `implement` refuses an application error encoding with a built-in `_tag`: a client could not
  tell them apart.
- A declared error without an `httpApiStatus` is sent as 422, not 500; a union without one
  sends each member at its own. Annotate `{ httpApiStatus: 500 }` to keep the old status.
- On MCP over HTTP, `Unauthenticated`, or a `Forbidden` naming `scopes`, is answered with its
  HTTP status, challenge and JSON, not a tool result, as MCP authorization defines.
- `Authentication.make` gives every 401 it covers without a challenge a `Bearer` one, naming
  `scopesRequired` and the metadata URL of a protected resource, and `invalid_token` when the
  request presented credentials. Serve public and authenticated actions of one binding in
  separate `ActionHttp.layer` calls. `MiddlewareOptions` is gone.
- `Authentication.make` marks its routes' responses `Cache-Control: no-store` unless the route
  states its own caching; a failure enclosing middleware serializes is always `no-store`.
- A client's argument may be omitted exactly when `{}` is a valid input. A given argument is
  sent as given; 0.7.0 sent `{}` for `undefined` or `null`.
- Commands and flags are kebab case: `get-user`, `--tenant-id`. A required boolean is a switch.
  Colliding names throw `Duplicate command` or `Duplicate flag` when the command is built. A
  remote command takes no client options: it calls through the host's `HttpClient`.
- A local command's error channel includes `Action.Refusal`.
- `ActionMcp.layerHttp`'s `path` defaults to `/mcp`.
- `Action.make` refuses a misspelled key, a name over 128 characters, and `hints.destructive`
  on a read.
- Each module exports `Options` for its main function, `<Function>Options` for another's, and
  `Any` for its erased value. `Action.Codec`, `Action.CodecOf`, `Action.Fields`,
  `ActionHttp.Api`, `ActionHttp.LayerOptions`, `ActionToolkit.Binding`, the `ActionHttpClient`
  and `ActionCliClient` types, and the MCP request types of `Testing` are gone. Use
  `Action.Any["input"]`, `Action.Any["hints"]` and `typeof Http.api` instead.
- The optional `@modelcontextprotocol/client` peer is gone. To drive the official client,
  depend on it and give it a `fetch` over `HttpRouter.toWebHandler(routes)`.

### Additions

- `input` and `success` take plain fields: `input: { id: Schema.String }`. `input: {}`, or
  `Schema.Struct({})`, is an action without input: a strict empty object, the root MCP needs.
- `success` is optional: omitted, it is `Schema.Void`, and a CLI command prints nothing.
- An `undefined` option takes its default, as an omitted one does, and one that may be either
  is typed as either: `success: enabled ? Schema.String : undefined` gives `string | void`.
- Handler parameters are typed from the contract in every `implement` form.
- `ActionHttp.make(actions, { errors: [RateLimited] })` declares errors middleware answers with
  on every endpoint, so clients decode them as typed failures. Handlers never fail with them.
- `scopesRequired` names the scopes every 401 of a protected resource asks for, so a first
  login requests the least rather than every scope supported.
- `Authentication.refusal(error, protectedResource?, authorization?)` is the response `make` answers a refusal
  with, for callers outside the router such as a WebSocket upgrade.
- `Action.Forbidden` may name the OAuth scopes a call lacks, `scopes: ["users:write"]`. On HTTP
  and MCP over HTTP it is a 403 with an `insufficient_scope` challenge, on which an MCP client
  re-authorizes and retries.
- `Testing.layer(routes)` answers any `HttpClient` user in memory: `ActionHttp.client`, the
  native `HttpApiClient`, a remote `ActionCli` command and `Testing.mcpClient`, which calls
  tools as `ActionHttp.client` calls routes. `Testing.mcpRequest` sends any stateless MCP
  request, with any `_meta` merged over the client metadata.
- A CLI flag's help text is its field's schema description.
- `ActionCli.make(target, { name, commands })` gives a subcommand the options `command` takes,
  by action name: `commands: { readFile: { positional: ["path"], render } }`.
- `ActionCli.command(implementations, Action, { positional: ["path"] })` takes the listed
  fields of a struct input as positional arguments, locally and over HTTP.
- `ActionToolkit.make(implementations, { needsApproval })` sets Effect's native
  `Tool.needsApproval` of each action's tool, a boolean or a function of each call's input,
  which `LanguageModel` honors.
- The package declares `"sideEffects": false`, and a browser bundle of `ActionHttp.client`
  keeps only the contracts, the binding and the client. Keep contracts and bindings in modules
  that import no server code ([setup.md](docs/setup.md#browser)).
- `ActionMcp.runStdio` serves MCP 2025-11-25 and 2025-06-18 again, beside 2026-07-28. HTTP
  serves 2026-07-28 only.

## 0.7.0

Built and tested against `effect` and `@effect/platform-node` `4.0.0-rc.117`. The `effect`
peer range is unchanged (`>=4.0.0-rc.116 <4.0.0`).

### Breaking changes

**`ActionHttpClient.promise` has no `token` option.** Its options are now the native
`HttpApiClient.make` options `baseUrl` and `transformClient`, passed through, plus `fetch`.
The native `transformResponse` is not offered: it may change a call's success, failure or
required services, which neither the method types nor `Effect.runPromise` can follow.

- Migrate: replace `token` with a `transformClient`, or with a `fetch` wrapper for a token read
  on each call:

  ```ts
  import { HttpClient, HttpClientRequest } from "effect/unstable/http";

  // before
  ActionHttpClient.promise(Http, { baseUrl, token });

  // after
  ActionHttpClient.promise(Http, {
    baseUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
  });
  ```

**`Action.make` has no `http` option.** HTTP serves every action of every group passed to
`ActionHttp.make`. Keeping an action off HTTP means putting it in a group that the HTTP binding
leaves out. There is no local-only action any more: `ActionCli` runs any action. `Action.Action`
and `Action.Options` lose their `Http` type parameter, so `Mcp` moves up one position, and an
action has no `http` field. `ActionCatalog` entries lose their `http` field, `httpSchemaErrors`
lists a group's policy errors for every action, and the catalog `version` is `"4"`. `make`
refuses keys that `Action.Options` does not declare, so a leftover `http` is a compile error
rather than an action that is now served. `make` infers the whole options object: its type
parameters are now `<Name, O>` instead of `<Name, Input, Output, Errors, Acc, Http, Mcp>`, so
explicit type arguments or instantiation expressions no longer compile.

- Migrate: delete `http: true`. For an action with `http: false`, move it to a group of its own
  (or of other actions hidden from HTTP), and leave that group out of `ActionHttp.make` while
  still passing it to `ActionMcp`, `ActionToolkit` or `ActionCli`:

  ```ts
  // before
  const ListChanges = Action.make("listChanges", { ..., http: false });
  const Users = ActionGroup.make({ name: "users" }, GetUser, ListChanges);
  const Http = ActionHttp.make({ apiPath: "/api" }, Users);

  // after
  const ListChanges = Action.make("listChanges", { ... });
  const Users = ActionGroup.make({ name: "users" }, GetUser);
  const Audit = ActionGroup.make({ name: "audit" }, ListChanges);
  const Http = ActionHttp.make({ apiPath: "/api" }, Users);
  // Audit's implementation goes to ActionMcp.layerHttp, ActionToolkit.make or ActionCli.
  ```

  Catalog readers: drop `http`, and check for `version: "4"`. Explicit `Action.make<...>` type
  arguments: delete them and let `make` infer.

  Library authors: a package whose published declarations were built against effect-actions
  0.6.0 or earlier names `Action.Action` with seven type arguments. Under 0.7.0 those
  references do not resolve, and with `skipLibCheck` its contracts silently degrade to `any`.
  Rebuild and republish such a package against 0.7.0 before its consumers upgrade.

**An `mcp` option that may serve the action keeps its requirements.** An action is typed hidden
from MCP only when its options' type has a required `mcp: false`, such as a literal
`mcp: false`. A conditional spread of `{ mcp: false }` and an `Action.Options` value whose `mcp`
is optional were typed hidden although they may serve the action, so an MCP layer dropped the
handler's request requirements and a served tool could fail on a missing service. They are now
typed served: the action's `mcp` type includes the resolved tool, and `ActionMcp` layers keep
the handler's requirements. `ActionToolkit` applies the same rule: every action whose `mcp` type
is not exactly `false` is a tool of the toolkit's type, carrying its handler's request
requirements. Before, an action whose `mcp` might be `false` at runtime (the forms above,
`false | undefined`, or `enabled ? { name } : false`) had no tool in the type although it had one
at runtime, and calling it could fail on a service the types never asked for. Literal
`mcp: false`, `mcp: { ... }` hints and omitted `mcp` infer exactly as before. A ternary
between hints and `false` (`enabled ? { name: "nt" } : false`) now types the tool name as
`string`; add `as const` to the hints branch to keep the literal name.

- Migrate: nothing for literal options. Where a layer or a toolkit call now requires a service
  it did not before, the action may be served: provide the service, or state `mcp: false`
  literally.

**Handlers must be own-property functions of a plain record.** 0.6.0 refused a record without
an own property for an action, or with `undefined` there. `implement` now also refuses one whose
value is not a function. A record that fails is refused with
`Missing handlers for group "<group>": <actions>`, at `implement` or, for a builder Effect's
record, when the adapter layer builds; before, a non-function value failed on its first request.
Handlers are called without a receiver.

- Migrate: nothing, unless a record held non-function values under action names; bind a
  function for every action.

### Other changes

- `ActionHttpClient.promise` and `Testing.httpClient` build the native client the same way,
  over `FetchHttpClient` with the given `fetch`. `promise` still looks the global `fetch` up on
  each call when none is passed.
- `Testing.mcpCall` reads `arguments` with a destructuring default; an omitted `arguments` is
  still sent as `{}`.
- `ActionMcp` documents that stdio refuses a host speaking an older revision deliberately, for
  uniformity with HTTP, although stdio has no sessions.

## 0.6.0

Built and tested against `effect` and `@effect/platform-node` `4.0.0-rc.117`. The `effect`
peer range is unchanged (`>=4.0.0-rc.116 <4.0.0`).

### Breaking changes

**MCP is 2026-07-28 only.** `ActionMcp.layerHttp` and `ActionMcp.layerStdio` no longer take
`protocols`; both serve `McpProtocol.v2026_07_28` and nothing else. Over HTTP the endpoint is
stateless: no `initialize` handshake and no session. A 2025-era client (one that opens with
`initialize`) is refused: over HTTP with status 400 and JSON-RPC error `-32020`, over stdio with
JSON-RPC error `-32022` on `initialize`. Stdio hosts must speak 2026-07-28. Without a
session, `notifications/cancelled` interrupts nothing over HTTP.

- Migrate: delete `protocols` from every `layerHttp`/`layerStdio` call, and delete local
  protocol lists (`[McpProtocol.v2026_07_28]` and the four-revision stdio lists). Clients
  must speak 2026-07-28; pin the official client with
  `versionNegotiation: { mode: { pin: "2026-07-28" } }`.

**`TestingClient.withMcpClient` has no `versionNegotiation` option.** It always pins
2026-07-28, the one revision served.

- Migrate: delete `versionNegotiation` from `withMcpClient` options.

**A group's `schemaError` policy states two answers; the library chooses between them.**
`{ errors, map }` is replaced by `{ invalid: { schema, make }, internal: { schema, make } }`.
A native `HttpApiSchemaError` from decoding the request (`Payload`, `Params`, `Headers`,
`Query`) is answered by `invalid`; one from encoding the handler's result (`Body`,
`ResponseHeaders`) by `internal`. `make` receives the failure and returns its schema's value.
`ActionGroup.SchemaErrorPolicy` now takes `<Invalid, Internal>` codecs instead of an error
tuple, `ActionGroup.SchemaErrorAnswer` is new, and a group's third type parameter is the union
of its policy's error codecs rather than a tuple.

- Migrate:

  ```ts
  // before
  const schemaError = {
    errors: [InvalidInput, InternalFailure],
    map: (failure: HttpApiError.HttpApiSchemaError) =>
      failure.kind === "Body" || failure.kind === "ResponseHeaders"
        ? new InternalFailure({ message: "The response could not be encoded." })
        : new InvalidInput({ message: failure.cause.message }),
  };

  // after
  const schemaError = {
    invalid: {
      schema: InvalidInput,
      make: (failure: HttpApiError.HttpApiSchemaError) =>
        new InvalidInput({ message: failure.cause.message }),
    },
    internal: {
      schema: InternalFailure,
      make: () => new InternalFailure({ message: "The response could not be encoded." }),
    },
  };
  ```

  A `make` that reads its failure needs the parameter annotation in a standalone constant
  (inline in `ActionGroup.make` it is inferred). Policies that branched on
  `kind === "Payload"` answered `Params`, `Headers` and `Query` as internal; those kinds never
  occur on action routes, so nothing observable changes.

**`implement` refuses a handler record that lacks an action.** A plain record throws at
`implement`; a builder Effect's record fails the adapter layer's build. Before, the missing
handler was a defect on the first request for that action. The message is now
`Missing handlers for group "<group>": <actions>`. Every adapter also selects its handlers
once, when it builds, rather than per request.

- Migrate: nothing, unless a record was deliberately incomplete; the types already required
  every handler.

### Additions

- `ActionMcp` options are the native `McpServer.layerHttp` / `layerStdio` options minus
  `protocols`, passed through unchanged: `description`, `websiteUrl`, `icons` and `extensions`
  now reach the server.
- `Http.openApi(path?)`: the binding's OpenAPI document as one `GET` route, at
  `<apiPath>/openapi.json` unless a path is given. Replaces
  `HttpRouter.add("GET", "/api/openapi.json", HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)))`;
  pass `"/openapi.json"` to keep a root path.
- `ActionHttpClient.promise(Http, { baseUrl?, token?, fetch? })`, a new subpath
  `@gjermundgaraba/effect-actions/ActionHttpClient`: `client.<group>.<action>(input)` for every
  HTTP-served action, resolving with the decoded success. It rejects with what the native
  `HttpApiClient` fails with: a declared error value (the action's, the policy's, or the
  binding's surface `errors`), a native `HttpClientError` (unreachable: `response` is
  `undefined`; or an undeclared status or unreadable body), or a `SchemaError`. `token` is sent
  as a bearer; `fetch` defaults to the global one, looked up per call; an omitted `baseUrl`
  keeps routes relative (the page's origin). It replaces hand-written wrappers of
  `Effect.runSync(HttpApiClient.make(...))`, `FetchHttpClient.Fetch`, a bearer
  `transformClient` and a `run` that re-throws failures; any classification of statuses into
  application errors stays with the caller. Other headers go through a wrapping `fetch`.
- `Testing.mcpCall(handler, { url, name, arguments?, headers? })`: one stateless `tools/call`,
  resolving with `{ isError: false, value }` (the `{ value }` envelope removed) or
  `{ isError: true, error }` (the error text, parsed as JSON when it is a declared error). It
  throws for a non-200 answer or a JSON-RPC error; `mcpRequest` still covers those. It replaces
  test helpers that parse the JSON or event-stream body and unwrap `structuredContent.value` or
  the `isError` text.

### Effect 4.0.0-rc.117

rc.117 generates MCP tool `outputSchema` differently (a top-level `$ref` is inlined). Every
effect-actions tool output is rooted at its `{ value }` object, so published tool schemas are
unchanged.
