# Changelog

## Unreleased

One contract, one `implement`, one binding. `ActionGroup` is gone: actions are implemented
directly, HTTP binds a flat list of actions, every client calls an action with its input, and a
builder runs once however many surfaces serve it.

### Breaking changes

**`ActionGroup` is removed; `Action.implement` binds handlers.** `implement(action, handler)`
and `implement([actions], { name: handler })` both return one `Implementation` of everything
they bind. Either takes an Effect that builds the handler or record instead. Adapters take one
implementation or a list of them, `[userActions, double]`, and serve every action of each.
Group-level `errors` and the group's `schemaError` policy are gone; `schemaError` moves to
`ActionHttp.make`.

A record must have exactly one handler per action: an extra key is now a compile error, where
0.7.0 ignored it. A plain handler or record is checked at `implement`, which throws
`Missing handlers: <names>` or `Unknown handlers: <keys>`; a builder's record is checked when
it is built, and the layer build dies with the same message.

- Migrate:

  ```ts
  // before
  const Users = ActionGroup.make({ name: "users" }, GetUser, RenameUser);
  const users = Users.implement(Effect.gen(function* () { ...; return { getUser, renameUser }; }));

  // after
  const users = Action.implement([GetUser, RenameUser], Effect.gen(function* () { ...; return { getUser, renameUser }; }));
  ```

  Errors shared by a group: spread one constant array into each action's `errors`.

**A builder runs once per host.** Each implementation's builder is a layer Effect memoizes, so
within one build of the host's layers it runs once however many HTTP layers, MCP endpoints and
Toolkits serve it, in the host's scope. 0.7.0 ran it once per adapter layer. It still runs again
in a separately built layer graph, and per invocation in `ActionCli`. Its startup services are
therefore provided once, above every surface: services provided around one surface now reach
the others, where 0.7.0 gave each adapter its own.

**`mcp: false` and `mcp.name` are removed.** A tool is named after its action, and `mcp` holds
only the hints (`readOnly`, `destructive`, `idempotent`, `openWorld`). A surface serves the
implementations passed to it, so an action stays off MCP by leaving its implementation out of
the MCP layer; implement it on its own if it shared a builder with served actions. Action names
are at most 128 characters, the MCP limit.

- Migrate: rename an action whose `mcp.name` differed (`get_user` becomes the tool `getUser`),
  or keep the old name as the action name; delete `mcp: false` and leave the implementation out
  of `ActionMcp` and `ActionToolkit`.

**`ActionHttp.make(actions, options?)` binds a flat list, as data.** Actions come first.
`prefix` (default `/api`) replaces the required `apiPath`, `schemaError` joins `errors` as a
binding option, and `name` sets the native group's name and OpenAPI tag (default: the mount
path's segments, such as `api` or `api/users`, or `actions` at the root). Each action is served at `POST <prefix>/<action>` with operation ID `<action>`, so names
are unique per binding; an API that reused names across groups uses one binding per area, each
with its own `prefix`. The binding is `{ actions, errors, prefix, schemaError, api }`, plain
data holding no server code, so a browser client importing it bundles none, and a copy of it,
or one made by another installed copy of the package, serves the same.
`ActionHttp.layer(Http, implementations, { before })` serves every action of the
implementations it receives, matched to the binding's actions by identity, and answers schema
failures with the binding's `schemaError`; its hook fails only with the binding's `errors`;
middleware provided to it covers only those actions. An implementation of an action outside the binding is refused,
and a bound action no layer serves answers 404. `ActionHttp.openApi(Http, path?)` defaults to
`<prefix>/openapi.json`.

- Migrate: `ActionHttp.make({ apiPath: "/api", errors }, Users)` becomes
  `ActionHttp.make([GetUser, RenameUser], { errors })` for `/api/getUser`, or
  `ActionHttp.make([GetUser, RenameUser], { prefix: "/api/users", errors })` to keep the
  `/api/users/getUser` routes; its OpenAPI tag is then `api/users`, unless `name` sets another.
  `Http.layer(apps)` becomes `ActionHttp.layer(Http, apps)` and
  `Http.openApi()` becomes `ActionHttp.openApi(Http)`. Callers of the native client follow the
  route change.

**Clients take the input, not `{ payload }`.** `ActionHttpClient.make(Http, options?)` is new:
the native `HttpApiClient`, one Effect method per action, `client.getUser({ id })`.
`ActionHttpClient.promise` and `Testing.httpClient(Http, handler)` are built on it;
`Testing.httpClient` takes the binding rather than `Http.api`. `Client<typeof Http>` and
`PromiseClient<typeof Http>` name their types. The argument may be omitted exactly when `{}` is
a valid input, and omitting it sends `{}`; a given argument is sent as given, where 0.7.0 sent
`{}` for an `undefined` or `null` argument.

**`schemaError` answers with the binding's own `errors`.** Each side is a function of the
native failure returning one of `errors`, `schemaError: { invalid: () => new InvalidRequest(...) }`,
and a side left out keeps Effect's empty 400. `ActionHttp.SchemaErrorPolicy`,
`ActionHttp.SchemaErrorAnswer` and the `{ schema, make }` answers are gone, and so is the
binding's third type parameter.

- Migrate: move each answer's `schema` into `errors`, and its `make` to the side itself:

  ```ts
  // before
  ActionHttp.make(actions, {
    errors: [Forbidden],
    schemaError: { invalid: { schema: InvalidRequest, make: () => new InvalidRequest(...) }, ... },
  });

  // after
  ActionHttp.make(actions, {
    errors: [Forbidden, InvalidRequest],
    schemaError: { invalid: () => new InvalidRequest(...) },
  });
  ```

**One guard object binds to every surface.** `{ errors, before }` is passed as it is to
`ActionMcp`, `ActionToolkit`, `ActionHttp.layer` and `ActionCli`: MCP and the Toolkit declare
its `errors` on their tools, HTTP declares the binding's and reads only `before`, and the CLI
reads only `before`, inferring its failure as 0.7.0 did.

- Migrate: nothing is required. To share one rule, bind one constant:
  `ActionHttp.layer(Http, apps, guarded)`, `ActionCli.command(app, Action, { ...guarded })`.

**`ActionCliClient` is merged into `ActionCli`.** A command from an HTTP binding calls the
action over HTTP, one from implementations runs it in process:
`ActionCli.command(Http, Action, options?)` and `ActionCli.make(Http, { name })`. The client's
`baseUrl` and `transformClient` are options of the command itself; `connection` is gone.

- Migrate: `ActionCliClient.command(Http, Action, { connection: { baseUrl } })` becomes
  `ActionCli.command(Http, Action, { baseUrl })`.

**CLI selectors are contracts.** `ActionCli.command(implementations, Action, options?)` and
`ActionCli.make(implementations, { name, before? })` replace
`ActionCli.command(app, "name")` and `ActionCli.group(app)`. `ActionCli.command(Http, Action)`
and `ActionCli.make(Http, { name })` replace the remote string selectors and
`ActionCliClient.group`. Aggregates give one subcommand per action. A `parameters`
command needs `input` unless its parsed values could be the encoded input (JSON, with every
key the encoded input requires and none it lacks), so an optional flag's `Option` is a compile error rather than a runtime `SchemaError`. A local command builds
only its own implementation's builder. A remote command calls through `ActionHttpClient`, so
it no longer accepts `transformResponse`, whose effect the command's error type could
not follow.

**`TestingClient` and `Testing.mcpRequest` are removed.** The package no longer has the
optional `@modelcontextprotocol/client` peer. `Testing.httpClient` and `Testing.mcpCall` take
what `Testing.serve` returns, or a web handler as before. `mcpCall` takes `path` and
`baseUrl`, not `url`; `path` defaults to `/mcp` and `baseUrl` to `http://localhost`.

- Migrate: assert on a tool's outcome with `Testing.mcpCall`. To drive the official client,
  depend on `@modelcontextprotocol/client` directly and pass it `fetch: server.handler`. For a
  raw MCP response, send your own `Request` to `server.handler`.

**Fewer exported types.** `Action.CodecOf`, `ActionHttp.Api`, `ActionHttpClient.Method`,
`ActionHttpClient.PromiseMethod`, and the MCP request types of `Testing` are no longer exported.
Use `Client<typeof Http>` and `PromiseClient<typeof Http>` for clients, and `typeof Http.api`
for the native API.

**`ActionMcp.layerHttp`'s `path` defaults to `/mcp`.**

**The catalog is version `"5"`.** `ActionCatalog.make` takes a list. Entries are
`{ name, description, access, mcp, input, success, errors }`: `group` and `httpSchemaErrors` are
gone, `access` is included, and `mcp` is the four resolved hints.

**Spans are named after the action.** The handler span is `<action>`, not `<group>.<action>`,
and `action.group` is no longer an attribute or log annotation. Action names are unique per
binding; to tell two bindings' same-named actions apart, read the route on the request span.

### Additions

- `input` and `success` take plain fields: `input: { id: Schema.String }` is
  `Schema.Struct({ id: Schema.String })`.
- Handler parameters are typed from the contract in every `implement` form, without
  annotations, and a generic handler such as `Effect.succeed` is inferred as itself.
- `Authentication.middleware(service, authenticate, { errors?, headers? })`: `authenticate` may
  fail with a declared error, sent as its JSON encoding with its `httpApiStatus` and `headers`,
  instead of a hand-built response. Pass `Http.errors` to declare it once; `headers` may be a
  function of the error. A response still works as before.
- `Authentication.bearerToken` reads the request's bearer token as an `Option`.
- `Testing.serve(routes)` serves routes in memory with the platform services provided and
  returns `{ handler, dispose }`.
- A CLI command with `parameters` and no `input` uses the parsed parameters as the input.

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
