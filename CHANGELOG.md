# Changelog

## Unreleased

One contract, one `implement`, one binding, one hook. `ActionGroup` is gone: actions are
implemented directly, HTTP binds a flat list of actions, every client calls an action with its
input, and a builder runs once however many surfaces serve it. The library now owns the
failures a surface answers with instead of a handler: bad input is a 400 `InvalidInput`, and a
`before` hook or authentication middleware refuses with `Unauthenticated` (401) or `Forbidden`
(403), which every endpoint and tool declares. CLI flags are derived from each action's input.
Clients and `Testing` are Effect-only, and `ActionCatalog` is removed.

### Breaking changes

**`ActionGroup` is removed; `Action.implement` binds handlers.** `implement(action, handler)`
and `implement([actions], { name: handler })` both return one `Implementation` of everything
they bind. Either takes an Effect that builds the handler or record instead. Surfaces take one
implementation or a list of them, `[userActions, double]`, and serve every action of each.
Group-level `errors` and `schemaError` are gone with the group: see the built-in errors below.

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

**`mcp` is `hints`; `mcp: false` and `mcp.name` are removed.** The `Action.make` option
`mcp: { ... }` is now `hints: { ... }`, the contract field `action.mcp` is `action.hints`, and
the type `Action.McpOptions` is `Action.Hints`. It holds only the hints (`readOnly`,
`destructive`, `idempotent`, `openWorld`); a tool is named after its action. A surface serves
the implementations passed to it, so an action stays off MCP by leaving its implementation out
of the MCP layer; implement it on its own if it shared a builder with served actions. Action
names are at most 128 characters, the MCP limit. `make` has one type parameter per option, so a
misspelled key is reported as `Object literal may only specify known properties`.

- Migrate: rename `mcp:` to `hints:` and `action.mcp` to `action.hints`. Rename an action whose
  `mcp.name` differed (`get_user` becomes the tool `getUser`), or keep the old name as the action
  name; delete `mcp: false` and leave the implementation out of `ActionMcp` and `ActionToolkit`.

**`ActionHttp.make(actions, options?)` binds a flat list, as data.** Actions come first, and the
only option is `prefix` (default `/api`), which replaces the required `apiPath`. Each action is
served at `POST <prefix>/<action>` with operation ID `<action>`, so names are unique per binding;
an API that reused names across groups uses one binding per area, each with its own `prefix`.
The OpenAPI tag is the mount path's segments (`api`, `api/users`), or `actions` at the root.
The binding is `{ actions, prefix, api }`, plain data holding no server code, so a browser
client importing it bundles none, and a copy of it, or one made by another installed copy of
the package, serves the same. `ActionHttp.layer(Http, implementations, { before })` serves every
action of the implementations it receives, matched to the binding's actions by identity;
middleware provided to it covers only those actions. An implementation of an action outside the
binding is refused, and a bound action no layer serves answers 404.
`ActionHttp.openApi(Http, path?)` defaults to `<prefix>/openapi.json`.

- Migrate: `ActionHttp.make({ apiPath: "/api", errors }, Users)` becomes
  `ActionHttp.make([GetUser, RenameUser])` for `/api/getUser`, or
  `ActionHttp.make([GetUser, RenameUser], { prefix: "/api/users" })` to keep the
  `/api/users/getUser` routes; its OpenAPI tag is then `api/users`. `Http.layer(apps)` becomes
  `ActionHttp.layer(Http, apps)` and `Http.openApi()` becomes `ActionHttp.openApi(Http)`.
  Callers of the native client follow the route change.

**Built-in errors replace surface `errors` and `schemaError`.** `Action.InvalidInput` (400),
`Action.Unauthenticated` (401) and `Action.Forbidden` (403) are tagged errors with body
`{ _tag, message }`, and `message` defaults, so `new Action.Forbidden()` works.
`Action.Refusal` is `Unauthenticated | Forbidden`. Every HTTP endpoint declares its action's
errors plus all three, and every MCP or Toolkit tool its action's errors plus the two
refusals, so every client decodes them as typed failures. Input that does not decode, malformed
JSON included, is always answered 400 `InvalidInput` whose `message` is the schema's own
description, such as `Expected string\n  at ["name"]`. A result that does not encode is a
defect: an empty 500, which a client sees as an `HttpClientError`. The `ActionHttp.make` options
`errors`, `schemaError` and `name`, the binding's `errors` and `schemaError` fields, the
`errors` option of every other surface, and `SchemaErrorPolicy` are gone.

- Migrate: delete `errors` and `schemaError` from `ActionHttp.make`, `ActionMcp`,
  `ActionToolkit` and `Authentication.middleware`. Replace application errors that stood for a
  refusal or bad input (`Unauthenticated`, `Forbidden`, `InvalidRequest`) with the built-in
  ones: fail with `new Action.Forbidden({ message })`, and catch `"Forbidden"` by tag on the
  client. Delete an application error whose `_tag` is `InvalidInput`, `Unauthenticated` or
  `Forbidden`: two schemas with one tag and status are indistinguishable to a client. An
  `internal` answer for unencodable results has no replacement: the result is a server bug.

**One `before` hook, failing with a refusal.** Every surface takes `{ before }`:
`ActionHttp.layer(Http, apps, { before })`, `ActionMcp.layerHttp(apps, { name, version, before })`,
`ActionToolkit.make(apps, { before })`, `ActionCli.command(apps, Action, { before })`.
`before: (action: Action.Any) => Effect<void, Action.Refusal, R>`: failing with anything else is
a type error. The CLI infers which refusals the hook fails with for the command's error channel.

- Migrate: a shared `{ errors, before }` guard becomes its `before` alone; pass
  `{ before: authorize }` instead of `guarded` or `...guarded`. A hook that failed with an
  application error fails with `Action.Forbidden` or `Action.Unauthenticated` instead.

**`Authentication.middleware(service, authenticate)` takes no options.** `authenticate` fails
with `Action.Unauthenticated`, answered 401 with its JSON and `WWW-Authenticate: Bearer`,
`Action.Forbidden`, answered 403 with no challenge, or an `HttpServerResponse` to send instead.
Every response still carries `cache-control: no-store`. `MiddlewareOptions` is gone.
`Authentication.protectedResource(options)` returns the router layer itself instead of
`{ layer, metadataUrl, challenge }`; `challenge()` and `BearerChallengeOptions` are gone. The
challenge names no metadata URL: an MCP client then probes the well-known URL
`protectedResource` serves, as the MCP authorization spec requires of clients.

- Migrate: drop the third argument of `middleware`, and fail with the built-in refusals.
  `Layer.mergeAll(routes, discovery.layer)` becomes `Layer.mergeAll(routes, discovery)`. For a
  custom challenge (`resource_metadata`, `scope`, `error`), fail with an `HttpServerResponse`
  carrying your own header.

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
`ActionCliClient.group`. A local command builds only its own implementation's builder. A
remote command calls through `ActionHttpClient`, so it no longer accepts `transformResponse`,
whose effect the command's error type could not follow.

**CLI flags are derived from the input.** A struct input gets one flag per top-level field,
named in kebab case (`tenantId` is `--tenant-id`) and parsed as the field's encoded value: a
string, a finite number, a boolean switch, a choice for a union of string literals, or JSON
for anything else. Every flag is optional to the parser; a missing required field fails with a
`SchemaError` (`Missing key`). An input that is not a struct gets one `--input <json>` flag.
Commands and subcommands are named after the action in kebab case (`getUser` is `get-user`);
two actions whose kebab names collide are refused with `Duplicate command: <name>`.
`parameters`, the `input` mapper, `--input-file`, and their types (`JsonOptions`,
`ParametersOptions`, `InputMapper`, `IsInput`) are gone.

- Migrate: `ActionCli.command(double, Double, { parameters: { value: Flag.String("value") } })`
  becomes `ActionCli.command(double, Double)`, still `double --value 21`. Scripts calling
  `--input '{"tenantId":"acme"}'` on a struct input pass `--tenant-id acme`, and subcommand
  `getUser` is `get-user`. `--input-file x.json` becomes `--input "$(cat x.json)"`, for an
  input that is not a struct. For a fixed syntax, build a native `Command` and call the
  handler or client in it.

**Clients take the input, not `{ payload }`; the Promise client is removed.**
`ActionHttpClient.make(Http, { baseUrl?, transformClient? })` is the native `HttpApiClient`,
one Effect method per action, `client.getUser({ id })`. `Client<typeof Http>` names its type.
The argument may be omitted exactly when `{}` is a valid input, and omitting it sends `{}`; a
given argument is sent as given, where 0.7.0 sent `{}` for an `undefined` or `null` argument.
`ActionHttpClient.promise`, `PromiseClient` and `PromiseOptions` are gone.

- Migrate: replace `ActionHttpClient.promise(Http, options).getUser(input)` with an Effect
  run at the edge:
  `Effect.runPromise(Effect.flatMap(ActionHttpClient.make(Http, options), (client) => client.getUser(input)).pipe(Effect.provide(FetchHttpClient.layer)))`.
  A custom `fetch` is `Effect.provideService(FetchHttpClient.Fetch, fetch)`.

**`Testing` is Effect-only; `TestingClient` and `Testing.mcpRequest` are removed.** The
package no longer has the optional `@modelcontextprotocol/client` peer. `Testing.layer(routes)`
is a `Layer<HttpClient>` answering requests with the routes in memory, built and released
with the layer; a relative URL resolves against `http://localhost`, so
`ActionHttpClient.make(Http)` needs no `baseUrl`. `Testing.mcpCall({ name, arguments?, path?,
headers? })` is an Effect on that `HttpClient`, failing with an `Error` holding the status and
body for a non-200 answer, no reply, or a JSON-RPC error. `Testing.serve`,
`Testing.httpClient`, `Handler` and `Server` are gone.

- Migrate:

  ```ts
  // before
  const server = Testing.serve(routes);
  const client = yield * Testing.httpClient(Http, server);
  const called = await Testing.mcpCall(server, { name: "greet", arguments });
  await server.dispose();

  // after, inside one program provided with Testing.layer(routes)
  const client = yield * ActionHttpClient.make(Http);
  const called = yield * Testing.mcpCall({ name: "greet", arguments });
  ```

  To drive the official MCP client, depend on `@modelcontextprotocol/client` directly and give
  it a `fetch` over a web handler:
  `const { handler, dispose } = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)))`
  and `fetch: (input, init) => handler(new Request(input, init))`.

**`ActionCatalog` is removed.** The module, its subpath and the catalog JSON are gone.

- Migrate: for a machine-readable contract, publish the OpenAPI document of an HTTP binding
  (`ActionHttp.openApi(Http)` or `OpenApi.fromApi(Http.api)`), or an MCP endpoint's
  `tools/list`.

**Fewer exported types.** `Action.CodecOf`, `Action.Options`, `Action.Fields`,
`ActionHttp.Api`, `ActionHttp.Options`, `ActionHttp.LayerOptions`, `ActionHttpClient.Method`,
`ActionHttpClient.PromiseMethod`, `ActionHttpClient.Options`, `ActionMcp.Options`,
`ActionMcp.StdioOptions`, `ActionToolkit.Options`, `ActionToolkit.Binding`, `ActionCli.Options`,
`ActionCli.RemoteOptions`, `ActionCli.MakeOptions`, `ActionCli.RemoteMakeOptions`,
`Authentication.ProtectedResourceOptions`, and the MCP request types of `Testing` are no longer
exported. Use `Client<typeof Http>` for clients, `typeof Http.api` for the native API, and
`Parameters<typeof ActionMcp.layerHttp>[1]` for an options type.
`ActionToolkit.make` returns `{ toolkit, layer }`.

**`ActionMcp.layerHttp`'s `path` defaults to `/mcp`.**

**Spans are named after the action.** The handler span is `<action>`, not `<group>.<action>`,
and `action.group` is no longer an attribute or log annotation. Action names are unique per
binding; to tell two bindings' same-named actions apart, read the route on the request span.

### Additions

- `input` and `success` take plain fields: `input: { id: Schema.String }` is
  `Schema.Struct({ id: Schema.String })`.
- Handler parameters are typed from the contract in every `implement` form, without
  annotations, and a generic handler such as `Effect.succeed` is inferred as itself.
- `Action.InvalidInput`, `Action.Unauthenticated`, `Action.Forbidden` and `Action.Refusal`:
  the built-in errors every surface declares.
- `Authentication.bearerToken` reads the request's bearer token as an `Option`.
- `Testing.layer(routes)` answers any `HttpClient` user in memory: `ActionHttpClient`, the
  native `HttpApiClient`, a remote `ActionCli` command, and `Testing.mcpCall`.
- A CLI flag's help text is its field's schema description.

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
