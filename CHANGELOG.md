# Changelog

## 0.9.0

One contract, one `implement`, one binding, one hook. `ActionGroup` is gone: actions are
implemented directly, HTTP binds a flat list of actions, and every client calls an action with
its input. An implementation carries its `before` hook, which every surface runs. The library
owns the failures a surface answers with: `InvalidInput` (400), `Unauthenticated` (401) and
`Forbidden` (403). CLI flags come from each action's input. Clients and `Testing` are
Effect-only, the client modules merge into `ActionHttp` and `ActionCli`, and `ActionCatalog` is
removed.

Built and tested against `effect` and `@effect/platform-node` `4.0.0-rc.118`. The `effect`
peer range is now `>=4.0.0-rc.118 <4.0.0`: rc.118 moved Effect's unstable modules to the top
level, so import `effect/http`, `effect/http-api`, `effect/cli` and `effect/ai` instead of
`effect/unstable/http`, `effect/unstable/httpapi`, `effect/unstable/cli` and
`effect/unstable/ai`. TypeScript 7 or newer is supported; earlier versions are not.

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

| 0.7.0                                                                                         | 0.8.0                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionGroup.make(...)`, `Group.implement(build)`                                             | `Action.implement(actions, build)`                                                                                                      |
| A group's `errors`                                                                            | `ActionHttp.make(actions, { errors })` for middleware's; an action's `errors` for its handler's                                         |
| `mcp: { ... }`, `action.mcp`, `Action.McpOptions`                                             | `hints: { ... }`, `action.hints`                                                                                                        |
| `mcp.name`                                                                                    | The action's name, which is the tool's                                                                                                  |
| `mcp: false`                                                                                  | Leave the implementation out of `ActionMcp` and `ActionToolkit`                                                                         |
| `hints.readOnly`                                                                              | `access: "read"`                                                                                                                        |
| `ActionHttp.make({ apiPath, errors, schemaError, name }, Group)`                              | `ActionHttp.make(actions, { prefix? })`: `prefix: "/api/users"` keeps `/api/users/getUser`                                              |
| `Http.layer(implementations, { before })`                                                     | `ActionHttp.layer(Http, implementations)`                                                                                               |
| `Http.openApi()`                                                                              | `HttpRouter.add("GET", path, HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)))`                                                 |
| `errors`, `schemaError`, `SchemaErrorPolicy` on any surface                                   | The built-in `Action.InvalidInput`, `Action.Unauthenticated` and `Action.Forbidden`                                                     |
| `before` on any surface, `ActionToolkit.make`'s second argument                               | `Action.implement(actions, handlers, before)`                                                                                           |
| A hook failing with an application error                                                      | A hook failing with `Action.Refusal`, `Unauthenticated` or `Forbidden`                                                                  |
| `Authentication.middleware(tag, authenticate).layer`                                          | `Authentication.make(tag, Effect.succeed(authenticate), resource?).layer`; `authenticate` may fail with a refusal                       |
| `Authentication.ProtectedResourceOptions`, `BearerChallengeOptions`                           | `Authentication.Options`, `make`'s third argument                                                                                       |
| `Authentication.protectedResource`, `challenge()`                                             | `make`'s third argument, which publishes discovery and names it in every challenge                                                      |
| A 401 challenge naming a scope                                                                | `scopesRequired` in `make`'s third argument                                                                                             |
| An `InsufficientScope` error and a hand-built challenge                                       | `new Action.Forbidden({ message, scopes: [scope] })`                                                                                    |
| The `ActionHttp.Http` type                                                                    | `ActionHttp.Binding`                                                                                                                    |
| `ActionHttpClient.make`, `ActionHttpClient.Client`                                            | `ActionHttp.client`, `ActionHttp.Client`                                                                                                |
| `ActionHttpClient.promise`                                                                    | A client built once with `FetchHttpClient.layer`, each call `Effect.runPromise`d (ActionHttp.md)                                        |
| `client.getUser({ payload })`                                                                 | `client.getUser(input)`                                                                                                                 |
| `ActionCliClient.command(Http, A, { connection: { baseUrl } })`, `ActionCliClient.group(...)` | `ActionCli.command(Http, A)`, `ActionCli.make(Http, { name })`, on a host `HttpClient` that prepends the URL                            |
| `ActionCli.command(app, "name")`, `ActionCli.group(app)`                                      | `ActionCli.command(implementations, Action)`, `ActionCli.make(implementations, { name })`                                               |
| `ActionCli.Options` of `command`, `ActionCli.GroupOptions`                                    | `ActionCli.CommandOptions` of `command`; `ActionCli.Options` is `make`'s                                                                |
| `parameters`, the `input` mapper, `--input-file`                                              | Flags from the input: `--tenant-id acme`; `--input "$(cat x.json)"` for an input that is not a struct                                   |
| `Testing.httpClient`, `Testing.Handler`, `TestingClient`                                      | `Testing.layer(routes)`, an in-memory `HttpClient` for every client                                                                     |
| `Testing.mcpCall(server, { name, arguments })`                                                | `Testing.mcpClient(actions, { url?, transformClient? })`, then `mcp.<action>(input)`                                                    |
| `Testing.mcpRequest({ url, method, params, headers })`, a `Request`                           | `Testing.mcpRequest(method, params?, { url?, headers? })`, an Effect of the response on the `HttpClient`                                |
| `ActionCatalog`                                                                               | `OpenApi.fromApi(Http.api)`, or an MCP endpoint's `tools/list`                                                                          |
| `ActionMcp.Options` of `layerHttp`                                                            | `ActionMcp.LayerHttpOptions`; `ActionMcp.Options` is the server's, which both functions take                                            |
| `Layer.launch(ActionMcp.layerStdio(implementations, options))`                                | `ActionMcp.runStdio(implementations, options)`, which succeeds when the host closes stdin                                               |
| `ActionMcp.StdioOptions`                                                                      | `ActionMcp.Options`, which `layerHttp` and `runStdio` both take                                                                         |
| `ActionToolkit.Binding`                                                                       | `ActionToolkit.Tools`, the same `{ toolkit, layer }`                                                                                    |
| `Logger.LogToStderr` provided to an stdio server                                              | Still provided, outermost, for services provided around `runStdio`; `runStdio` sends its own Effect logs and `Console` output to stderr |
| Span `<group>.<action>`, attribute `action.group`                                             | Span `<action>`                                                                                                                         |

Behavior that changes without a rename:

- A record has exactly one handler per action: an extra key is a compile error, which 0.7.0
  ignored. `implement` throws `Missing handlers: <names>` or `Unknown handlers: <keys>`; a
  builder's record is checked when its layer builds.
- A builder runs once per layer graph, however many surfaces serve it; 0.7.0 ran it once per
  adapter layer. Provide `Action.layer(implementations)` with its startup services once, above
  every surface, `HttpRouter.serve` included. `ActionCli` still runs it per invocation.
- Routes are `POST <prefix>/<action>`, `/api` by default, with operation ID `<action>`, so
  action names are unique per binding. The OpenAPI tag is the mount path, such as `api/users`,
  or `/` at the root.
- Every endpoint declares its action's errors, its binding's, and the three built-in ones, and
  every tool its action's and the three. Any handler may fail with them unlisted. Input that
  does not decode, malformed JSON included, is a 400 `InvalidInput` carrying the schema's
  message. A result that does not encode is an empty 500.
- HTTP refuses an undeclared input field, nested ones too, with a 400 `InvalidInput` naming
  its path; 0.7.0 dropped it. A client drops one when it encodes.
- `implement` refuses an `errors` entry encoding with a built-in `_tag`, the built-in itself
  included: every surface declares it already, and a client could not tell a look-alike apart.
- A declared error without an `httpApiStatus` is sent as 422, not 500; a union without one
  sends each member at its own. Annotate `{ httpApiStatus: 500 }` to keep the old status.
- Under `Authentication.make`, `Unauthenticated`, or a `Forbidden` naming `scopes`, from a hook
  or a handler, is answered with its HTTP status, challenge and JSON, on MCP too instead of a
  tool result, as MCP authorization defines. If an MCP handler's notification has already
  started the response, a later refusal remains a tool error in that stream. Without
  `Authentication.make`, such a refusal is a declared error.
- `Authentication.make` gives every 401 it covers without a challenge a `Bearer` one, naming
  `scopesRequired` and the metadata URL of a protected resource, and `invalid_token` when the
  request presented a bearer token.
- `Authentication.make`'s second argument is a builder, as `implement`'s may be: what it
  yields is a startup requirement of the middleware's layer, built once per layer graph
  (`authentication.layer.pipe(Layer.provide(Verifier.layer))`), and it returns the
  per-request authentication. What that yields beyond the request is still a request
  requirement, which only middleware combined before it supplies
  (`authentication.combine(resolveTenant).layer`). 0.7.0's `authenticate` had no startup
  phase: every service it yielded was a request requirement.
- A protected resource's discovery is published by the middleware's layer, once per layer
  graph, whichever composition builds it. It carries `Access-Control-Allow-Origin: *` and
  answers its own CORS preflight (204, allowing `GET`, `HEAD` and `OPTIONS` and the requested
  headers), so a browser MCP client reads it after a 401. Where the host's CORS middleware
  runs first, its policy answers discovery's preflight and adds its headers to discovery's
  reads, which keep the `*` where it sets no origin.
- Middleware covers the routes of the layer it is provided to: serve public and authenticated
  actions of one binding in separate `ActionHttp.layer` calls.
- `ActionHttp` answers a request without a content type with 415, as an MCP endpoint does;
  0.7.0 read it as JSON. A page on any origin can send such a body, with the caller's cookies,
  without a CORS preflight. The library's clients send `Content-Type: application/json`; a raw
  caller adds it.
- On `ActionHttp` and `ActionMcp`, a value a request gets from authentication,
  `HttpRouter.provideRequest` or other router middleware wins over one the routes were built
  with under the same tag, as on native routes and in a Toolkit call; a startup value only
  fills in one the request lacks. 0.7.0 let the startup value win: an identity provided at a
  server's root replaced the authenticated caller, and routes built inside a span parented
  their action spans to it. A value provided around `HttpRouter.serve` or the program is the
  request's too, so it also wins over one provided to a single surface's layer, which 0.7.0
  let override it there; scope such a value with `HttpRouter.provideRequest`. Still never
  provide an identity at startup: a route no authentication covers serves every caller as it.
- `Authentication.make` marks its routes' responses `Cache-Control: no-store` unless the route
  states its own caching; a failure enclosing middleware serializes is always `no-store`.
- A client's argument may be omitted exactly when `{}` is a valid input, and then sends the
  input `{}` decodes to, so an input class whose fields are all optional may be left out. A
  given argument is sent as given; 0.7.0 sent `{}` for `undefined` or `null`.
- Commands and flags are kebab case: `get-user`, `--tenant-id`. A required boolean is a switch.
  Colliding names throw `Duplicate command` or `Duplicate flag` when the command is built. A
  remote command takes no client options: it calls through the host's `HttpClient`.
- An input that is not a struct is one `--input` flag. Left off, it is `{}`, which the schema
  decodes when the command runs, never when it is built.
- A command refuses an undeclared field in `--input` or a flag's JSON with a `SchemaError`;
  0.7.0 dropped it. JSON of a kind the field takes stays JSON even when it breaks a rule, so
  the schema reports the rule and its path.
- A Toolkit tool takes and gives JSON, as MCP's does: `tools.handle` takes JSON arguments, and
  a tool's schemas are `Schema.toCodecJson` of the action's. 0.7.0 decoded a model's JSON with
  the action's schemas, refusing an ISO string for a `Schema.Date`.
- Errors one caller may receive have distinct `_tag`s: `implement` and `ActionHttp.layer`
  refuse two with one.
- Each `ActionToolkit.make` call's handlers are its own: two toolkits with tools of one name
  never run each other's handlers, their layers provided together in either order. `toolkit`
  is still a native `Toolkit`, which `Toolkit.merge` combines with other tools.
- `Action.layer(implementations)` builds their builders once, above every surface, including
  routes that `HttpRouter.serve` or `Testing.layer` build apart.
- `Testing.layer` runs requests in the context it is built in, as `HttpRouter.serve` does.
- What `Testing.layer`'s routes still require is its own, as under `HttpRouter.serve`: a
  builder's services, which the test program then shares, and a per-request service no
  middleware of theirs provides, including one a global middleware reads, such as the caller a
  test stands in for authentication.
- `Testing.layer` never requires the platform services `FileSystem`, `Path`, `HttpPlatform`
  and `Etag.Generator`, and one provided around it is the routes' own, at build and per
  request: a builder, a handler and a file route read files through the `FileSystem` a test
  provides. `HttpServer.layerServices`' defaults stand in for the rest, whose `FileSystem` is
  a no-op.
- `runStdio` gives its program a `Console` whose every method writes to stderr, so console
  loggers such as `Logger.consoleJson`, `Console.log`, and the counters, timers and group
  labels Node's console prints on stdout never corrupt the protocol from its builders, hooks
  and handlers. It counts, times and warns with the labels of Node's console, and indents
  inside a group; `dir` takes no inspect options, `table` prints its data without a grid or
  column filter, and `clear` does nothing. Layers provided around it log outside it: provide
  `Logger.LogToStderr` outermost.
- `ActionMcp.layerHttp` and `runStdio` refuse an implementation whose action's input is not
  one object with keys, a union, an array, a scalar, or an object without keys such as a given
  `Schema.Struct({})`, as a type error naming the actions:
  `Property '"MCP tool input must be one object with keys, such as a struct"' is missing`. Such
  input compiled, and the layer build died. Input the types do not check, erased, a helper's
  own type parameter, or one choice of an argument chosen by a condition when another passes,
  still dies when the layer builds, with `McpServer cannot register tool '<name>'`; when no
  choice passes, it is a type error. A helper listing an implementation typed by its
  type parameter (`[app, status]`), or generic over actions (`Action.AnyImplementation<A>`),
  no longer compiles: take the implementations as its type parameter,
  `<const Apps extends ReadonlyArray<Action.AnyImplementation>>(apps: Apps)`, and spread them,
  `[...apps, status]`.
- A local command's error channel includes `Action.BuiltIn`.
- `ActionMcp.layerHttp`'s `path` defaults to `/mcp`.
- `Action.make` refuses a misspelled key, in `hints` too, a name over 128 characters, and
  `hints.destructive` on a read; it also refuses hints typed by a helper's type parameter, so
  type that parameter `Action.Hints`.
- Each module exports `Options` for its main function, `<Function>Options` for another's, and
  `Any` for its erased value. `Action.Codec`, `ActionHttp.Api`, `ActionHttp.LayerOptions`, the
  `ActionHttpClient` and `ActionCliClient` types, and `Testing`'s `McpCallOptions`,
  `McpCallResult`, `McpRequestParams` and `McpRequestValue` are gone. Use `Action.Any["input"]`,
  `Action.Any["hints"]` and `typeof Http.api` instead.
- The optional `@modelcontextprotocol/client` peer is gone. To drive the official client,
  depend on it and give it a `fetch` over `HttpRouter.toWebHandler(routes)`.

### Additions

- `input` and `success` take plain fields: `input: { id: Schema.String }`. `input: {}`, or no
  `input`, is an action without input: a strict empty object, the root MCP needs. A given
  schema, `Schema.Struct({})` included, is kept as it is.
- `success` is optional: omitted, it is `Schema.Void`, and a CLI command prints nothing by
  default or with `--json`; a custom `render` may print text.
- `Action.share(actions, implementation, before?)` serves some of an implementation's actions
  behind its hook, or `before` instead, sharing its builder's one run per host build.
- An `undefined` option takes its default, as an omitted one does, and one that may be either
  is typed as either: `success: enabled ? Schema.String : undefined` gives `string | void`.
- Handler parameters are typed from the contract in every `implement` form.
- `ActionHttp.make(actions, { errors: [RateLimited] })` declares errors middleware answers with
  on every endpoint, so clients decode them as typed failures. Handlers never fail with them.
- `scopesRequired` names the scopes every 401 of a protected resource asks for, so a first
  login requests the least rather than every scope supported.
- `Action.Forbidden` may name the OAuth scopes a call lacks, `scopes: ["users:write"]`. Under
  `Authentication.make` it is a 403 with an `insufficient_scope` challenge, on which an MCP
  client re-authorizes and retries.
- `Authentication.bearerToken` reads the request's bearer token as a `Redacted<string>`,
  failing with `Unauthenticated` without one; `Effect.option(bearerToken)` where it is optional.
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
- The package declares `"sideEffects": false`, so a bundler may drop what a browser client
  does not use. Keep contracts and bindings in modules that import no server code
  ([setup.md](docs/setup.md#browser)).
- `ActionMcp.runStdio` serves every MCP revision from 2024-11-05, beside 2026-07-28, as the host
  negotiates; 0.7.0 served 2026-07-28 only. HTTP serves 2026-07-28 only.

## 0.8.0

Built and tested against `effect` and `@effect/platform-node` `4.0.0-rc.118`. The `effect`
peer now starts at rc.118 (`>=4.0.0-rc.118 <4.0.0`).

### Breaking changes

**The `effect` peer starts at `4.0.0-rc.118`.** rc.118 moved Effect's HTTP, HTTP API, CLI, AI
and process modules out of `effect/unstable/*`, and the package imports them from their new
paths, so an older release candidate fails with `Cannot find module 'effect/http'`.

- Migrate: install `effect` and `@effect/platform-node` `4.0.0-rc.118`, and import
  `effect/http`, `effect/http-api`, `effect/cli`, `effect/ai` and `effect/process` instead of
  `effect/unstable/http`, `effect/unstable/httpapi`, `effect/unstable/cli`,
  `effect/unstable/ai` and `effect/unstable/process`.

**MCP tools send their success without the `{ value }` envelope.** `structuredContent` is the
encoded success itself, of any JSON type, and the text content is its JSON. A tool's
`outputSchema` describes the encoded success. MCP 2026-07-28, the only revision served, allows
any JSON value there and any `outputSchema` root. Errors are unchanged.

- Migrate: an MCP client reads `structuredContent` instead of `structuredContent.value`.
  `Testing.mcpCall` already unwrapped the envelope, so its `value` is unchanged.

  ```ts
  // before: {"structuredContent":{"value":42},"content":[{"type":"text","text":"{\"value\":42}"}]}
  // after:  {"structuredContent":42,"content":[{"type":"text","text":"42"}]}
  ```

**HTTP input is closed.** An HTTP server refuses an input field the action does not declare:
an empty 400, or the group's `schemaError` `invalid` answer. Such fields were stripped before.
Typed HTTP clients fail with `SchemaError` on an undeclared field, before sending. The
published OpenAPI already said `additionalProperties: false`, and MCP tools were already
strict.

- Migrate: stop sending the extra fields, or declare them in the action's `input`.

### Additions

- `mcp.text` names a string field of the encoded success, such as a document body. MCP sends
  it once, raw, as the first text block, followed by the JSON of the rest, and leaves it out
  of `structuredContent` and of the listed `outputSchema`. A success without the field, which
  may be optional, is sent whole. Other surfaces serve the whole success. Building the MCP
  layer fails when the field is not a top-level property of the success's JSON Schema, as for
  a union of structs.

  ```ts
  export const ReadPage = Action.make("readPage", {
    description: "Read one page of a document as Markdown.",
    input: Schema.Struct({ url: Schema.String }),
    success: Schema.Struct({ markdown: Schema.String, next: Schema.optionalKey(Schema.String) }),
    access: "read",
    mcp: { name: "read_page", text: "markdown" },
  });
  ```

- `Testing.mcpCall` resolves a success with `text`, the text field, when one was sent, and
  accepts any JSON `structuredContent`.
- `ActionCatalog` entries record `mcp.text` in `mcp`.

### Other changes

- `ActionCatalog` schemas are closed (`additionalProperties: false`), as in the OpenAPI
  document.
- `ActionGroup.make` no longer refuses two actions with the same MCP tool name. The Toolkit or
  MCP binding that serves both refuses them, so a group served only over HTTP may keep them.
- `docs/ActionMcp.md` lists the fields the native server adds to every result
  (`_meta["io.modelcontextprotocol/serverInfo"]` and `resultType`), so a result's encoded size
  can be computed.

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
