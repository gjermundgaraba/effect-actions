# Changelog

## 0.10.0

One contract, one implementation, one hook. `ActionGroup` is gone: `Action.implement` binds
handlers to actions behind a `before` hook, which every implementation states, `Action.allowAll`
where no action-level rule applies, and every surface runs. HTTP binds a flat list of actions,
and each layer serves those its implementations hold. Every client calls an action with its
input, and `Action.client` calls implementations in process, which is how their behavior is
tested. Every endpoint and tool declares the built-in `InvalidInput` (400), `Unauthenticated`
(401) and `Forbidden` (403). A builder runs once per layer graph, each call has a scope of its
own, and a request's own values win over startup ones. CLI flags come from each action's input,
and a command runs on Effect's own `NodeRuntime.runMain`, printing a failure on stderr as the
JSON HTTP sends. The client modules merge into `ActionHttp` and `ActionCli`, clients and
`Testing` are Effect-only, and `ActionCatalog` and `TestingClient` are removed. `mcp.text` becomes
the `text` hint, and stdio also serves the revisions back to 2024-11-05, so
Claude Code and Codex connect. The docs say where builders and your own services are built, and
show one MCP URL for signed-out and signed-in callers.

Built and tested against `effect` and `@effect/platform-node` `4.0.0`. The `effect` peer narrows
to `~4.0.0`, Effect's 4.0.x patches: the modules every surface builds on are unstable in Effect,
so a minor release may change them, and a later minor is admitted once the package is tested
against it: install `effect` and every `@effect/*` package at 4.0.x. TypeScript 7 or newer is
supported; earlier versions are not.
0.9.0 kept 0.8.0's API and behavior, so these notes compare with 0.8.0.

### Breaking changes

```ts
// 0.8.0
const Users = ActionGroup.make({ name: "users" }, GetUser, RenameUser);
const users = Users.implement(build);
const Http = ActionHttp.make({ apiPath: "/api", errors }, Users);
Http.layer([users], { before: authorize });
const ReadPage = Action.make("readPage", { ..., mcp: { name: "read_page", text: "markdown" } });
const pages = ActionGroup.make({ name: "pages" }, ReadPage).implement({ readPage: read });
ActionMcp.layerHttp([users, pages], { name, version, path: "/mcp", errors, before: authorize });

// 0.10.0
const users = Action.implement([GetUser, RenameUser], build, authorize);
const Http = ActionHttp.make([GetUser, RenameUser]);
ActionHttp.layer(Http, users);
const ReadPage = Action.make("readPage", { ..., hints: { text: "markdown" } });
const pages = Action.implement(ReadPage, read, authorize);
ActionMcp.layerHttp([users, pages], { name, version });
```

Each area below lists what is renamed or removed, then what changes without a rename.

#### Contracts

| 0.8.0                                                                     | 0.10.0                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp: { ... }`, `action.mcp`, `Action.McpOptions`                         | `hints: { ... }`, `action.hints`, `Action.Hints`                                                                                                                                                                                 |
| `mcp.name`                                                                | The action's name, which is the tool's: `get_user` becomes the tool `getUser`, so update hosts' allowed tools and prompts. To keep a tool's name, give it to the action, which also names its route, client method and command   |
| `mcp.readOnly`                                                            | `access: "read"`                                                                                                                                                                                                                 |
| `mcp: { text: "markdown" }` on `Action.make`                              | `hints: { text: "markdown" }` on `Action.make`, which every MCP endpoint and `Testing.mcpClient` read                                                                                                                            |
| `mcp: false`                                                              | A list of the actions that are tools, beside the contracts, and `Action.share(Tools, app)` given to `ActionMcp` and `ActionToolkit`: an action added later is no tool until it is listed ([Action.md](docs/Action.md#contracts)) |
| `Action.Codec`                                                            | `Action.Any["input"]`                                                                                                                                                                                                            |
| `Action.Action`'s `Mcp` type parameter, `Action.Options`' type parameters | `Action.Action<Name, Input, Success, Errors, Access>`; `Action.Options` has none                                                                                                                                                 |

- `Action.make` throws `Invalid action name: <name>` for a name over 128 characters, which 0.8.0
  refused only as a tool name: shorten it. Its types refuse an unknown hint, such as a
  misspelling, `hints.destructive` on a read, and hints typed by a helper's type parameter:
  type that parameter `Action.Hints`.

#### Implementations and hooks

| 0.8.0                                                                                        | 0.10.0                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionGroup.make(...)`, `Group.implement(build)`                                            | `Action.implement(actions, build, before)`, with `Action.allowAll` where 0.8.0 passed no `before`                                                                                  |
| `ActionGroup.Implementation`; `Group`, `Any` and `Options`                                   | `Action.Implementation`, inferred, never spelled out: a helper takes implementations as a type parameter ([Action.md](docs/Action.md#rules)); a group is a list of actions         |
| `ActionGroup.contracts(...groups)`, `Contracts`                                              | The actions themselves, or a binding's `Http.actions`                                                                                                                              |
| `app.group`                                                                                  | `app.actions`, its exact contracts                                                                                                                                                 |
| `app.build`                                                                                  | `Action.client(app)`, then `client.<action>(input)`: its handlers behind its hook, in process, the methods `ActionHttp.client` has; a surface's own behavior under `Testing.layer` |
| A group's `errors`                                                                           | One array spread into each action's `errors`; `ActionHttp.make(actions, { errors })` for middleware's, such as a rate limit's; authentication's refusals are built in              |
| A group's `schemaError`, `SchemaErrorPolicy`, `SchemaErrorAnswer`                            | Nothing: input that does not decode is the built-in `Action.InvalidInput`, and a success that does not encode is a defect, an empty 500                                            |
| `before` of `Http.layer`, `ActionMcp`, `ActionToolkit.make`, `ActionCli.command` and `group` | `Action.implement(actions, handlers, before)`                                                                                                                                      |
| A hook failing with the surface's `errors`; `errors` of `ActionMcp` and `ActionToolkit`      | A hook failing with an `Action.Refusal`, or with an error every action of its implementation declares: one array, such as `[RateLimited]`, spread into each action's `errors`      |
| `before`'s `action`, an `Action.Any`                                                         | `before`'s `action`, typed as the implementation's own actions, in a built hook too                                                                                                |
| Span `<group>.<action>`, attribute and log annotation `action.group`                         | Span `<action>`                                                                                                                                                                    |

- Every implementation states who may call it: `before` is required, and `Action.allowAll` is
  the hook without an action-level rule. In 0.8.0 `before` was an option of `Http.layer`,
  `ActionMcp.layerHttp` and `layerStdio`, `ActionToolkit.make`, `ActionCli.command` and
  `ActionCli.group`, and leaving it out meant no authorization. Where 0.8.0 passed none, pass
  `Action.allowAll`. Where it guarded one surface and not another, implement once with the
  hook, and serve the other surface `Action.share(actions, app, Action.allowAll)`; a surface
  that had a hook of its own takes its share with that hook. Without a hook, `implement` does
  not compile (`Expected 3 arguments, but got 2`), and from plain JavaScript it throws
  `Missing hook: pass an authorization hook, or Action.allowAll`. `undefined` is not a hook:
  `before: enabled ? authorize : undefined` becomes `enabled ? authorize : Action.allowAll`.
- A hook fails with a refusal, or with an error every action of its implementation declares,
  which every surface declares for that action and every client decodes: HTTP answers with its
  status and JSON, MCP with an `isError` tool result, the Toolkit with a typed failure, and a
  CLI command with the same JSON on stderr. Only a refusal steps up under
  `Authentication.make`. 0.8.0's hook failed with its surface's `errors`, which that surface
  alone declared, and a CLI's with any error: move a limit from a surface's `errors` into each
  guarded action's `errors`, spreading one array, or keep a limit applied before decoding in
  HTTP middleware, with `ActionHttp.make`'s `errors`. An action that lacks the error is a type
  error naming `Refusal`, not the action.
- One action takes its handler, and a builder for it returns the handler, not a record: a
  one-action group's `.implement({ greet: handler })` becomes
  `Action.implement(Greet, handler, before)`. A list takes a record keyed by action name, as a
  group did.
- A record has exactly one handler per action: an extra key is a compile error, which 0.8.0
  ignored. `implement` throws `Missing handlers: <names>` or `Unknown handlers: <keys>`; a
  builder's record is checked when its layer builds.
- Within one layer graph a builder runs once, however many surfaces serve its implementation.
  This reverses 0.8.0's "An implementation served by two adapters is built twice", once per
  adapter layer: a builder is a memoized layer, so what it acquires, such as a connection
  pool, serves every surface of the graph, as a layer's services do. `HttpRouter.serve` and
  `Testing.layer` build their routes in a graph of their own, which reuses what the graph
  around them has built, so one rule places builders and your own services alike: with one
  server, put everything the process runs, a job or an agent beside the routes included, in
  the layer it serves; otherwise provide `Action.layer(implementations)` and the services they
  share above the server and its siblings. `HttpRouter.provideRequest` also builds the layer it
  provides in a graph of its own, so a model loop in a route takes its toolkit from its
  implementation's builder ([ActionToolkit.md](docs/ActionToolkit.md#rules)). To give an HTTP
  or MCP surface a build and startup services of its own, as 0.8.0's adapter layers had, wrap
  it in `Layer.fresh`, and provide what the surfaces share, authentication included, outside
  it. `ActionCli` still builds per invocation
  ([dependency lifetimes](docs/guarantees.md#dependency-lifetimes)).
- A builder's startup services are one union, `A | B` as written, so providing them in two
  `Layer.provide` calls, one per service, discharges both. 0.8.0 typed them `NoInfer<A | B>`,
  which stayed owed after both calls and showed in every hover.
- Each call has a scope of its own, on every surface: what a hook or a handler acquires is
  released when the call ends, the handler's first, and a fiber it forks with
  `Effect.forkScoped` is interrupted. In 0.8.0 a Toolkit call made with `tools.handle`, or
  approved through `LanguageModel`, held it until its caller's scope closed, so with a pooled
  connection per call, a third call on a pool of two waited forever. Over HTTP, a handler's
  finalizers now run before the route middleware around it resumes, and before the success
  is encoded, rather than when the request's scope closes. A resource that must outlive a
  call belongs to the builder, or to a service the host provides around its calls. `Scope`
  is never a request-time requirement: `runStdio`, a Toolkit tool, `tools.handle` and
  `LanguageModel.generateText` need no `Effect.scoped` for a handler that acquires; drop one
  added only for the types.
- `make` refuses an `errors` entry encoding with a built-in `_tag`, behind `Schema.suspend`
  or among a union of `_tag` literals or an enum's values too. So does `ActionHttp.make` for
  such an entry in a binding's `errors`, the built-in itself included: it throws
  `ActionHttp binding: error _tag "Unauthenticated" is built in, and declared on every surface`
  though `make`'s types accept it. Drop the `Unauthenticated` and `Forbidden` 0.8.0 declared in
  `ActionHttp.make`'s `errors` for the authentication's 401 and the hook's 403: every endpoint
  declares the built-in ones. Replace an `Unauthenticated` or `Forbidden` of your own with the
  built-in one, in hooks and handlers too. One kept there still compiles, since its `_tag` and
  `message` match the built-in's. It is then sent as the built-in without its other fields, so
  0.8.0's example's `permission` would be lost. Use
  ``new Action.Forbidden({ message: `Requires ${permission}.` })``, adding `scopes` only for
  OAuth scopes.
- Errors one caller may receive have distinct `_tag`s: `Action.make` refuses two with one, and
  `ActionHttp.make` an action's beside its binding's, so give each a tag of its own. Both are
  checked where the contract or binding is made, so a client of a contract no server of this
  package serves cannot decode a look-alike as a built-in error either. A top-level
  `Schema.suspend` in `errors` is resolved then: one whose thunk reads a `const` declared later
  throws a `ReferenceError` at `make`.
- A helper passing implementations it is given beside its own takes them as one type parameter,
  `<const Apps extends ReadonlyArray<Action.AnyImplementation>>(apps: Apps)`, and spreads it,
  `[...apps, double]`, or takes one, `<App extends Action.AnyImplementation>(app: App)`, and
  lists it, `[app, double]`, as 0.8.0's `Http.layer([app, double])` took it. A helper may share
  actions its type parameters stand for, `Action.share([action], app)`. A value typed
  `Action.AnyImplementation` owes `unknown`, on every surface's layer.
- An implementation is served, shared and called only by the installed copy of the package
  whose `Action.implement` made it. Another copy's surfaces, `Action.client`, `Action.share`
  and `Action.layer` throw
  `Not an implementation made by this Action.implement: is effect-actions installed twice?`,
  a local CLI command when it runs, where 0.8.0 served it. Install one copy. Contracts and
  bindings still cross copies.

#### HTTP

| 0.8.0                                                                                  | 0.10.0                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionHttp.make({ apiPath, errors }, ...groups)`                                      | `ActionHttp.make(actions, { prefix?, errors? })`: `prefix: "/api/users"` keeps `/api/users/getUser`                                                                                                                                                                        |
| The `ActionHttp.Http` type, `Http.groups`                                              | `ActionHttp.Binding`, `Http.actions`                                                                                                                                                                                                                                       |
| `ActionHttp.Api`, `ActionHttp.LayerOptions`                                            | `typeof Http.api`; `layer` takes no options                                                                                                                                                                                                                                |
| `Http.layer(implementations, { before })`                                              | `ActionHttp.layer(Http, implementations)`                                                                                                                                                                                                                                  |
| A group left out of `ActionHttp.make`, implemented apart, to keep its actions off HTTP | The actions left out of `ActionHttp.make`, implemented with the others                                                                                                                                                                                                     |
| `Http.openApi()`                                                                       | `HttpRouter.add("GET", path, HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)))`, the route 0.6.0's `openApi` replaced: `Http.api` is native                                                                                                                        |
| `ActionCatalog`                                                                        | `OpenApi.fromApi(ActionHttp.make(actions).api)` of the actions to describe, offline. A binding no layer serves may hold actions HTTP leaves out, such as a tool for agents, which `Http.api` omits. Or use an MCP endpoint's `tools/list`. Hints are each action's `hints` |
| `HttpApiClient.make(Http.api)`'s `client.users.getUser({ payload })`                   | `ActionHttp.client(Http)`'s `client.getUser(input)`; natively `client.getUser({ payload })`                                                                                                                                                                                |
| `ActionHttpClient.promise(Http, options)`                                              | A client built once with `FetchHttpClient.layer`, each call `Effect.runPromise`d ([ActionHttp.md](docs/ActionHttp.md#promise-callers)), the wrapper 0.6.0's `promise` replaced: clients are Effect-only                                                                    |
| `ActionHttpClient.Client`, `Method`, `Options`                                         | `ActionHttp.Client`, `ActionHttp.ClientOptions`; `fetch` is `FetchHttpClient.Fetch`                                                                                                                                                                                        |

- Routes are `POST <prefix>/<action>`, `/api` by default, with operation ID `<action>`, so
  action names are unique per binding; 0.8.0's were `POST <apiPath>/<group>/<action>`, with
  operation ID `<group>.<action>`. The OpenAPI tag is the mount path, such as `api/users`, or
  `/` at the root, rather than the group's name.
- `ActionHttp.layer` serves the binding's actions among the implementations it is given. An
  implementation's other actions, such as a tool for agents, get no route, and their names are
  not checked. This reverses 0.7.0's way to keep an action off HTTP, a group of its own that the
  binding left out, since `Http.layer` refused an implementation of any other group
  (`Implementation of group "x" is not served by this adapter`): such an action took an
  implementation of its own, its builder and hook repeated. An implementation holding none of
  the binding's actions is still refused, as the wrong one, when `layer` is called:
  `No action of this implementation is in this HTTP binding: x`. Two implementations of one
  served action throw `Duplicate served action: <name>`, where 0.8.0 threw
  `Duplicate implementation group: <group>`; actions the binding leaves out may repeat. A layer
  owes per request its implementations' hooks and the handlers of the actions it serves. It
  serves every bound action its implementations hold, so a layer without authentication takes
  only implementations of public actions; where one implementation holds public and protected
  actions, each layer takes an `Action.share` of its own
  ([ActionHttp.md](docs/ActionHttp.md#rules)).
- Every endpoint declares its action's errors, its binding's, and the three built-in ones, and
  every tool its action's and the three. Any handler may fail with the built-in ones unlisted.
  Input that does not decode, malformed JSON included, is a 400 `InvalidInput` carrying the
  schema's message, and a result that does not encode is an empty 500; 0.8.0 answered both
  with an empty 400, or with its group's `schemaError` answers. Nothing replaces
  `schemaError`: input needs no error of your own, since every surface declares
  `InvalidInput`, and a success that does not encode means the handler broke its contract
  after it ran, so any write it made has already happened, which a declared error would
  misreport. Defects, crashes and proxies send a 5xx without a declared body anyway. Delete
  the policy, and its `internal` error unless a handler fails with it.
- A declared error without an `httpApiStatus` is sent as 422, not 500; a union without one
  sends each member at its own. Annotate `{ httpApiStatus: 500 }` to keep the old status.
- `ActionHttp` answers a request without a content type with 415, as an MCP endpoint does;
  0.8.0 read it as JSON. A page on any origin can send such a body, with the caller's cookies,
  without a CORS preflight. The library's clients send `Content-Type: application/json`; a raw
  caller adds it.
- On `ActionHttp` and `ActionMcp`, a value a request gets from authentication,
  `HttpRouter.provideRequest` or other router middleware wins over one the routes were built
  with under the same tag, as on native routes and in a Toolkit call; a startup value only
  fills in one the request lacks. 0.8.0 let the startup value win: an identity provided at a
  server's root replaced the authenticated caller, and routes built inside a span parented
  their action spans to it. A value provided around `HttpRouter.serve` or the program is the
  request's too, so it also wins over one provided to a single surface's layer, which 0.8.0
  let override it there; scope such a value with `HttpRouter.provideRequest`. Still never
  provide an identity at startup: a route no authentication covers serves every caller as it.
- A typed client drops an undeclared input field when it encodes, nested ones too, instead of
  failing with `SchemaError` before sending: `ActionHttp.client`, the native `HttpApiClient` on
  `Http.api`, and `Testing.mcpClient`. This reverses 0.8.0's "Typed HTTP clients fail with
  `SchemaError` on an undeclared field": TypeScript lets a wider value through, so a call the
  compiler accepted failed. The server still refuses the field from a raw caller: HTTP with a
  400 `InvalidInput` naming its path, MCP as invalid arguments. No call needs changing; to
  assert the refusal, send a raw request.
- A client's argument may be omitted exactly when `{}` is a valid input, and then sends the
  input `{}` decodes to, so an input class whose fields are all optional may be left out. A
  given argument is sent as given; 0.8.0's Promise client sent `{}` for `undefined` or `null`.

#### Authentication

| 0.8.0                                                                            | 0.10.0                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authentication.middleware(tag, authenticate).layer`                             | For a bearer credential, `Authentication.make(tag, Effect.succeed(authenticate), resource?).layer`, where `authenticate` may fail with a refusal; for a session cookie, Effect's `HttpRouter.middleware`, answering its own 401 and setting `Cache-Control: no-store` |
| `Authentication.ProtectedResourceOptions`, `BearerChallengeOptions`              | `Authentication.Options`, `make`'s third argument                                                                                                                                                                                                                     |
| `Authentication.protectedResource`: its `layer`, `metadataUrl` and `challenge()` | `make`'s third argument, which publishes discovery and names its URL in every challenge                                                                                                                                                                               |
| A 401 challenge naming a scope                                                   | `scopesRequired` in `make`'s third argument                                                                                                                                                                                                                           |
| An insufficient-scope error of your own and a hand-built challenge               | `new Action.Forbidden({ message, scopes: [scope] })`                                                                                                                                                                                                                  |

- Under `Authentication.make`, `Unauthenticated`, or a `Forbidden` naming `scopes`, from a hook
  or a handler, is answered with its HTTP status, challenge and JSON, on MCP too instead of a
  tool result, as MCP authorization defines. If an MCP handler's notification has already
  started the response, a later refusal remains a tool error in that stream. Without
  `Authentication.make`, such a refusal is a declared error.
- `Authentication.make` gives every 401 it covers without a challenge a `Bearer` one, naming
  `scopesRequired` and the metadata URL of a protected resource, and `invalid_token` when the
  request presented a bearer token. 0.8.0 left each 401 as the host rendered it.
- `Authentication.make`'s second argument is a builder, as `implement`'s may be: what it
  yields is a startup requirement of the middleware's layer, built once per layer graph
  (`authentication.layer.pipe(Layer.provide(Verifier.layer))`), and it returns the
  per-request authentication. What that yields beyond the request is still a request
  requirement, which only middleware combined before it supplies
  (`authentication.combine(resolveTenant).layer`). 0.8.0's `authenticate` had no startup
  phase: every service it yielded was a request requirement.
- A protected resource's discovery is published by the middleware's layer, once per layer
  graph, whichever composition builds it, where 0.8.0's `discovery.layer` was merged beside the
  routes. It carries `Access-Control-Allow-Origin: *` and answers its own CORS preflight (204,
  allowing `GET`, `HEAD` and `OPTIONS` and the requested headers), so a browser MCP client
  reads it after a 401. Where the host's CORS middleware runs first, its policy answers
  discovery's preflight and adds its headers to discovery's reads, which keep the `*` where it
  sets no origin.
- `Authentication.make` keeps a route's own `Cache-Control`, which 0.8.0's `middleware`
  replaced with `no-store`; every other response of its routes, and a failure enclosing
  middleware serializes, is still `no-store`. A route stating its own says `private` unless
  its answer is the same for every caller: a credential a proxy forwards is invisible to a
  cache in front of that proxy.

#### MCP

| 0.8.0                                                                              | 0.10.0                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ActionMcp.Options<Errors, R>` of `layerHttp`, `ActionMcp.StdioOptions<Errors, R>` | `ActionMcp.LayerHttpOptions<A>`; `ActionMcp.Options<A>` is the server's, which `layerHttp` and `runStdio` both take |
| `Layer.launch(ActionMcp.layerStdio(implementations, options))`                     | `ActionMcp.runStdio(implementations, options)`, which succeeds when the host closes stdin                           |

- `runStdio` gives its program a `Console` whose every method writes to stderr, so console
  loggers such as `Logger.consoleJson`, `Console.log`, and the counters, timers and group labels
  Node's console prints on stdout never corrupt the protocol from its builders, hooks and
  handlers. A counter or a timer prints its label and its count or the milliseconds since it
  started, a group prints its label without indenting what follows, and `clear` does nothing.
  Layers provided around it run outside its program: keep `Logger.LogToStderr` outermost, as in
  0.8.0. It moves their default logger to stderr, but not their `Console` output or
  `Logger.consoleJson`: log JSON there with `Logger.withConsoleError(Logger.formatJson)`.
- `ActionMcp.layerHttp` and `runStdio` throw for an action whose input is not one object with
  keys, such as a union, an array, a scalar, or an object without keys such as a given
  `Schema.Struct({})`, naming the actions:
  `MCP tool input must be one object with keys, such as a struct: <name>`. Such input compiled,
  and the layer build died with `McpServer cannot register tool '<name>'`.
- A text field's tool sends text alone: a success holding the field as a string is two text
  blocks, the field once, raw, then the JSON of the rest, and any other success the JSON of the
  whole, with no `structuredContent`, and the tool lists no `outputSchema`. 0.8.0 sent the rest
  as `structuredContent` too, where a host preferring structured content showed the model the
  rest without the field, and listed an `outputSchema` without the field. A program reading
  the rest as structured content reads the JSON of the second text block instead;
  `Testing.mcpClient`, reading the same hint, does. Every other surface serves the whole
  success. `text` is typed by `make`: a top-level string field of the encoded success,
  optional or not, which a scalar, array, union or record success does not have.
  0.8.0 accepted a union member's field, or any name for a record, and then failed the layer
  build. Where the types cannot tell, as for an erased success or a union of one struct, the
  build still fails with
  `MCP tool '<name>' cannot send '<field>' as text: it is not a top-level property of its success`.
  Make such a success one struct, or drop the hint.

#### Toolkit

| 0.8.0                                                                    | 0.10.0                                                                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionToolkit.Binding<Tools, E, R>`, `ActionToolkit.Options<Errors, R>` | `ActionToolkit.Tools<T, E, R>`, the same `{ toolkit, layer }`, each type argument required; `ActionToolkit.Options<A>`, over the served actions, holds only `needsApproval` |

- A Toolkit tool takes and gives JSON, as MCP's does: `tools.handle` takes JSON arguments, and
  a tool's schemas are `Schema.toCodecJson` of the action's. 0.8.0 decoded a model's JSON with
  the action's schemas, refusing an ISO string for a `Schema.Date`. Pass `tools.handle` the
  JSON a model sends, such as that ISO string.
- A Toolkit tool belongs to its implementation. Two implementations with tools of one name,
  such as one and an `Action.share` of it behind another hook, never run each other's
  handlers, their layers provided together in either order; 0.8.0 found a tool's handler by
  its name alone, so one layer answered every toolkit's tool of that name, behind that
  layer's own `before`. The `layer` of any `make` call serves the tools of its
  implementations in any `toolkit`, and of an `Action.share` of one that keeps its hook, such
  as an agent's fewer tools, so toolkits made per agent or per approval policy run with one
  handler layer, built once. Two layers of one implementation, built apart with
  different services and provided together, serve its tools from one of them: use separate
  implementations for separate services. `toolkit` is still a native `Toolkit`, which
  `Toolkit.merge` combines with other tools.

#### CLI

| 0.8.0                                                                                                                            | 0.10.0                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionCliClient.command(Http, "users", "getUser", { connection })`, `ActionCliClient.group(...)`                                | `ActionCli.command(Http, GetUser, { client: { baseUrl } })`, `ActionCli.make(Http, { name, client })`: `client` takes `ActionHttp.client`'s options, on the host's `HttpClient`                                                                                                                                                                                                                                                                     |
| `ActionCli.command(app, "name")`, `ActionCli.group(app)`                                                                         | `ActionCli.command(implementations, Action)`, `ActionCli.make(implementations, { name })`                                                                                                                                                                                                                                                                                                                                                           |
| `ActionCli.Options` of `command`, `GroupOptions`; `ActionCliClient.Options`, `GroupOptions`, `Connection`                        | `ActionCli.CommandOptions` of `command`, local or remote; `ActionCli.Options` is `make`'s; `CommandOptions<typeof Action>` takes the action, where 0.8.0's `Options<Output, …>` took its success                                                                                                                                                                                                                                                    |
| A command failing with the action's failure itself: `Effect.catchTag("UserNotFound", ...)` after `Command.run`                   | `ActionCli.Failure<E>`, Effect CLI's `CliError.UserError` whose `cause` is the failure: `Effect.catchTag("UserError", (error) => error.cause instanceof UserNotFound ? ... : Effect.fail(error))`                                                                                                                                                                                                                                                   |
| `Effect.tapCause(...)`, `Logger.LogToStderr` and `NodeRuntime.runMain({ disableErrorReporting: true })` around `Command.runWith` | `Command.run(cli, { version })` on `NodeRuntime.runMain`, unless stdout feeds scripts (below)                                                                                                                                                                                                                                                                                                                                                       |
| `--input '<json>'`, `--input-file`, `parameters` and its `input` mapper                                                          | Flags from the input: `--tenant-id acme`; `--input "$(cat x.json)"` for an input that is not a struct; a syntax `name`, `positional` and `render` cannot express, such as a flag alias, a flag named apart from its field, or nested input built from several flags, is a native `Command.make` calling `Action.client`, or `ActionHttp.client` over HTTP, whose failures it maps to `CliError.UserError` ([ActionCli.md](docs/ActionCli.md#rules)) |

- Commands and flags are kebab case: `get-user`, `--tenant-id`. A required boolean is a switch;
  any other required field's flag, left out, is refused by the parser before the implementation
  is built, `Missing required flag: --<flag>` on stderr after the command's help on stdout.
  Colliding names throw `Duplicate command` or `Duplicate flag` when the command is built. A
  remote command or aggregate takes its connection as `client`, the options `ActionHttp.client`
  takes, `baseUrl` and `transformClient`, which reach its own requests alone: 0.8.0's
  `connection` without `transformResponse`. A URL or token read when a command runs, as from
  `Config`, configures the `HttpClient` provided on the command,
  `Command.provideEffect(HttpClient.HttpClient, ...)`.
- A field holding an array of strings or numbers, choices included, takes a repeated flag, one
  element per occurrence: `--provider exa --provider hn`. Given none, a required field is `[]`
  and an optional one is left out; a `Schema.NonEmptyArray` field's flag is required once. Any
  other array, and an array taken as a positional argument, takes JSON.
- A command whose action fails prints the failure on stderr as the JSON HTTP sends for it, such
  as `{"_tag":"UserNotFound","id":"9"}`, through Effect's CLI formatter, and exits 1, or with
  the failure's `Runtime.errorExitCode`. It fails with Effect CLI's `UserError`, whose `cause`
  is the action's failure, which `Command.run` prints and marks reported, so `runMain` does not
  print it again. 0.8.0 failed the command with the action's failure itself, which `runMain`
  printed on stdout with a stack and without its fields, and the documented program printed the
  raw `Cause` on stderr instead; delete that block. A failure no schema encodes, a builder's or
  the transport's, prints as its tag, or an error's name, and its message, and each cause's, up
  to one already printed, never its other fields. `Command.run` prints a command's failure
  before a host's `Effect.catchTag("UserError", ...)` runs, so a host that recovered silently or
  printed its own text provides a `formatError` through `CliOutput.layer`, or runs with
  `renderErrors: false`.
- A command refuses input that does not decode with `Action.InvalidInput`, as HTTP does,
  printed as the body of HTTP's 400, an undeclared field in `--input` or a flag's JSON
  included, which 0.8.0 dropped. 0.8.0's parser refused an `--input` or `--input-file` value
  that did not decode and showed the command's help (`ShowHelp` containing `InvalidValue`);
  an omitted input that did not decode, or the input a `parameters` mapping made, failed with
  a `SchemaError`.
- A success that does not encode is a defect, as it is HTTP's empty 500, and nothing prints it
  as a result; 0.8.0 failed the command with a `SchemaError`.
- What a command runs, the builder, hook and handler, or a remote command's client call, and the
  codecs of its input, success and failures, writes its Effect logs and `Console` output to
  stderr, whatever logger prints them, and the command writes only its result to stdout. 0.8.0
  wrote them to stdout unless the program provided `Logger.LogToStderr`, which moves only the
  default logger. The global `console.log` and other direct writes bypass Effect and still reach
  stdout: keep them off stdout. Layers the host provides, on the command or around the run, log
  outside the command, and `runMain` reports a defect, and a failure of such a layer, on stdout:
  a CLI whose stdout feeds scripts keeps `Logger.LogToStderr` outermost, which moves those
  layers' default logger but not their `Console` output or `Logger.consoleJson`, runs `runMain`
  with `disableErrorReporting`, and reports on stderr itself
  ([ActionCli.md](docs/ActionCli.md#rules)).
- A local command's `Failure` includes `Action.BuiltIn`, whatever its implementation's hook.

#### Testing

| 0.8.0                                                                                                                                     | 0.10.0                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Testing.httpClient(api, handler)`, `Testing.Handler`                                                                                     | `Testing.layer(handler)`: the native `HttpClient`, answered by the web handler, on which `ActionHttp.client(Http)` and every other client call it; `Testing.layer(routes)` builds the routes itself                                                                                                                                              |
| `Testing.mcpCall(handler, { url, name, arguments, headers })`, resolving `{ isError: false, value, text? }` or `{ isError: true, error }` | `Testing.mcpClient(actions, { url?, transformClient? })`, then `mcp.<action>(input)`: the decoded success, or a typed failure. An action with a `text` hint has its success read from its text blocks                                                                                                                                            |
| `Testing.mcpRequest({ url, method, params, headers })`, a `Request`                                                                       | `Testing.mcpRequest(method, params?, { url?, headers? })`, an Effect of the response on the `HttpClient`                                                                                                                                                                                                                                         |
| `Testing.McpCallOptions`, `McpCallResult`, `McpRequestParams`, `McpRequestValue`                                                          | None: `mcpClient` types each call, and `params` are JSON                                                                                                                                                                                                                                                                                         |
| `TestingClient.withMcpClient`, `McpClientOptions`, the optional `@modelcontextprotocol/client` peer                                       | Depend on the official client, `new Client(info, { versionNegotiation: { mode: { pin: "2026-07-28" } } })`. Give its transport `fetch: (input, init) => web.handler(new Request(input, init))`, with `web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)))` as 0.8.0's tests built it; or use `Testing.mcpClient` |

### Additions

- `input` and `success` take plain fields: `input: { id: Schema.String }`. `input: {}`, or no
  `input`, is an action without input: a strict empty object, the root MCP needs. A given
  schema, `Schema.Struct({})` included, is kept as it is.
- `success` is optional: omitted, it is `Schema.Void`, and a CLI command prints nothing by
  default or with `--json`; a custom `render` may print text.
- An `undefined` option takes its default, as an omitted one does, and one that may be either
  is typed as either: `success: enabled ? Schema.String : undefined` gives `string | void`.
- A hook may be an Effect that builds it, as a builder builds handlers. What the Effect yields,
  such as a permission store, is a startup requirement, provided once beside the builders'
  services; what the hook it returns yields, such as the caller, stays per request. It is built
  once per layer graph for its implementation, and per invocation of a local command. A 0.8.0
  hook that read a store owed it per request, supplied with `HttpRouter.provideRequest` on each
  surface: yield the store in the Effect instead, and provide its layer at startup. A 0.8.0
  hook built in `Layer.unwrap` around a surface becomes that Effect, passed to `implement`,
  which builds it once per implementation in each layer graph: build what several
  implementations or the surfaces share outside it. A service whose value is the hook,
  `implement(actions, handlers, Guard)`, is built once for every implementation it guards.
- `Action.share(actions, implementation, before?)` serves some of an implementation's actions
  behind its hook, or `before` instead, sharing its builder's one run per layer graph. `before`
  may be `Action.allowAll`, for a public subset, or built, as `implement`'s may; given one, the
  source's hook is neither built nor run for its actions, and its startup services are not
  required. It throws `Not implemented by this implementation: <names>` for an action its
  source does not implement.
- `Action.client(implementations)` calls implementations in process: one method per action,
  taking its input directly, as `ActionHttp.client`'s methods do, so moving between an
  in-process and a remote caller changes the line acquiring it. A call runs as a remote one
  does, through the dispatch every surface shares: its input passes through its JSON codec,
  encoded to JSON text then decoded, the hook and the handler run in a scope of their own, and
  the success or the failure passes through its codec too. It fails with the action's errors and
  the built-in ones, as a remote caller decodes them: input that does not pass is
  `InvalidInput`, before the hook, and a success or a failure that does not, an error the action
  does not declare included, is a defect, as it is an empty 500 over HTTP: its `SchemaError`,
  then the failure itself. Each call owes what the hook and the handler read, the caller's
  identity included, provided around the call, never around the acquisition. Acquiring it builds
  the implementations into the layer graph around it, as a layer does, sharing each builder's
  run with the surfaces of that graph: acquire it in a builder, a layer or a scoped program,
  never per request. It is how an implementation's own behavior is tested, several callers in
  one test, an action no binding holds included; `Testing.layer` tests what a surface adds.
  `Action.Client<Apps>` is its type.

  ```ts
  const asAlice = Effect.provideService(CurrentActor, alice); // each call's caller

  Effect.gen(function* () {
    const users = yield* Action.client(userActions); // once, where builders live
    return yield* users.renameUser({ id: "1", name: "Bea" }).pipe(asAlice);
  });
  ```

- `ActionHttp.make(actions, { security, public })` states in the OpenAPI document what the
  authentication around the routes reads: `security` takes Effect's own schemes, keyed by
  their OpenAPI name, and every endpoint but a `public` action's requires one of them.
  `OpenApi.fromApi`, Swagger and Scalar show them, and a combined document keeps each
  binding's. Without it, as in 0.8.0, the document states no security, and Swagger offers no
  Authorize. It enforces nothing: `layer` serves every endpoint without it, the
  authentication around a layer admits or refuses, and clients are unchanged.

  ```ts
  ActionHttp.make([Status, GetUser], {
    security: { bearer: HttpApiSecurity.bearer },
    public: [Status],
  });
  ```

- A binding states where it mounts, `Http.prefix`: `/api` by default, `/` at the root, without
  a trailing slash.
- The package declares `"sideEffects": false`, so a bundler may drop what a browser client
  does not use. Keep contracts and bindings in modules that import no server code
  ([setup.md](docs/setup.md#browser)).
- `scopesRequired` names the scopes every 401 of a protected resource asks for, so a first
  login requests the least rather than every scope supported.
- `Action.Forbidden` may name the OAuth scopes a call lacks, `scopes: ["users:write"]`. Under
  `Authentication.make` it is a 403 with an `insufficient_scope` challenge, on which an MCP
  client re-authorizes and retries.
- `Authentication.bearerToken` reads the request's bearer token as a `Redacted<string>`,
  failing with `Unauthenticated` without one; `Effect.option(bearerToken)` where it is optional.
- `ActionMcp.runStdio` serves every MCP revision from 2024-11-05, beside 2026-07-28, as the
  host negotiates, so hosts that open with `initialize`, such as Claude Code and Codex,
  connect. This reverses 0.6.0's "Stdio hosts must speak 2026-07-28", which 0.7.0 kept on
  purpose for uniformity with HTTP, and which made 0.8.0's `layerStdio` refuse them. HTTP
  still serves 2026-07-28 only: Codex, which opens HTTP with `initialize` as well, connects
  over stdio ([ActionMcp.md](docs/ActionMcp.md#failure-modes)). MCP successes stay bare on
  every transport and revision, as in 0.8.0: on 2026-07-28 `structuredContent` is the encoded
  success and the text content is its JSON. On the revisions 0.8.0 refused, Effect's adapters
  decide what is structured: 2025-11-25 and 2025-06-18 carry only an object success as
  `structuredContent` and list only an object-rooted `outputSchema`; 2025-03-26 and 2024-11-05
  structure nothing. A success they do not structure is text alone, its JSON or, for a string
  success, the string itself, so a host on those revisions reads a non-object success from the
  text.
- `ActionMcp.layerHttp`'s `path` defaults to `/mcp`, where 0.8.0 required it.
- `ActionToolkit.make(implementations, { needsApproval })` has `LanguageModel` ask for
  approval of a model's call before it runs, through Effect's native `Tool.needsApproval`:
  one check over every call, `(call, context) =>` a boolean or an `Effect` of one, where
  `call` holds the action's `name`, the `action` and the decoded `input`. Checking
  `call.name` narrows `call.input`, across implementations too. The check requires nothing
  and runs in the caller's context, so it reads the caller with `Effect.serviceOption`, and
  one toolkit serves callers with different policies. A check that fails means no approval
  is needed, as `LanguageModel` decides natively. `tools.handle` ignores approval.

  ```ts
  ActionToolkit.make([users, documents], {
    needsApproval: (call) => call.name === "erase" && call.input.id !== "draft",
  });
  ```

- A CLI flag's help text is its field's schema description.
- `ActionCli.make(target, { name, commands })` gives a subcommand the options `command` takes,
  by action name: `commands: { readFile: { positional: ["path"], render } }`.
- `ActionCli.command(implementations, Action, { positional: ["path"] })` takes the listed fields
  of a struct input as positional arguments, locally and over HTTP. A suspended input or field,
  as a recursive schema is written, takes the flags and arguments of the schema it stands for,
  and its description.
- `Testing.layer(routes)` answers any `HttpClient` user in memory: `ActionHttp.client`, the
  native `HttpApiClient`, a remote `ActionCli` command and `Testing.mcpClient`, which calls
  tools as `ActionHttp.client` calls routes. Requests run in the context it is built in, as
  under `HttpRouter.serve`, and what the routes still require, such as the caller a test
  stands in for authentication, is provided around it. It never requires the platform
  services `FileSystem`, `Path`, `HttpPlatform` and `Etag.Generator`: one provided around it
  is the routes' own, and `HttpServer.layerServices`' defaults stand in for the rest, whose
  `FileSystem` is a no-op. Its client is its own: the program's other HTTP clients get none of
  its requests, and it none of theirs.

### Other changes

- `Action` and `ActionHttp`, and every module they import, import Effect only through
  `effect`, `effect/http` and `effect/http-api`, so a page that loads Effect from an import
  map serving them bundles no second copy; setup.md says what such a map serves. A Vite+
  bundle is unchanged; an esbuild bundle of a page calling `ActionHttp.client` grows by about
  5.6 kB gzipped.
- The docs add failure modes for a builder that runs twice, a job or an agent beside
  `HttpRouter.serve` reading other state than the routes, and surfaces all answering with one
  surface's startup services. A model loop in a route yields its toolkit in its implementation's
  builder, and the route's layer takes the toolkit's `layer` with `Layer.provide`: one build,
  shared with every surface of the routes' graph serving its implementations. `Effect.provide`
  in the handler builds it for every call unless a surface of the graph serves the same
  implementations, and `HttpRouter.provideRequest` in a graph of its own, a second time beside
  such a surface as `Layer.mergeAll`'s order decides
  ([ActionToolkit.md](docs/ActionToolkit.md#rules)).
- The failure modes of a forgotten authentication show what TypeScript reports,
  `Type 'CurrentActor' is not assignable to type 'never'` where the server is launched,
  `Expected 2 arguments, but got 1` at a web handler's `handler(request)`, and
  `Request<"Requires", CurrentActor>` in a layer's type, where 0.8.0's named
  `HttpRouter.Request.From<"Requires", CurrentActor>`, which TypeScript does not print. They
  warn against the fix that error invites: an identity provided around `HttpRouter.serve` or
  the program, or passed as every `handler(request, context)` call's context, compiles, and
  every request to those routes then runs as that identity, one without credentials included
  ([Authentication.md](docs/Authentication.md#failure-modes)).
- Authentication.md shows one MCP URL for signed-out and signed-in callers
  ([examples/mcp-sign-in.ts](examples/mcp-sign-in.ts)). The authentication provides an
  optional identity, and only reading the credential is optional,
  `Effect.option(Authentication.bearerToken)`, so a presented token that does not verify is
  still a 401. The hook of each protected implementation refuses a signed-out caller with
  `Unauthenticated`: the 401 on which the official MCP client signs in and retries the call;
  whether another host does is the host's. Signed-out callers then list every tool, get a
  protected tool's input errors before its 401, and call every implementation whose hook and
  handlers do not refuse them, so separate endpoints stay the default, as in the example app.
- Authentication.md adds a rule: the per-request authentication verifies a token's audience,
  that it was issued for this `resource`, as MCP authorization requires (RFC 8707). `make`
  reads no token; one issued for another resource fails with `Unauthenticated`, as any token
  that does not verify.
- Authentication.md adds a rule: route middleware provided around routes runs before the
  authentication inside them only while that authentication is not combined into other
  middleware, as the `b` of an `a.combine(b)` or inside one, since Effect runs a route's
  middleware deepest first in a combination. A check that must run before any credential is
  read, such as a Host or Origin policy, is global middleware,
  `HttpRouter.middleware(check, { global: true })`, merged beside the routes, as the example
  app's request policy now is.
- guarantees.md adds a rule: a handler or hook maps another service's refusals before failing
  with them. An `Unauthenticated` or `Forbidden` that a client such as `ActionHttp.client`
  decodes is, passed on as it is, this server's own: under `Authentication.make` it sends a
  caller whose token is valid to sign in again, its 401 naming `invalid_token`, or to
  re-authorize for the other service's scopes
  ([authorization](docs/guarantees.md#authorization)).
- guarantees.md states that every MCP tool call, over HTTP and over stdio, and every Toolkit
  call runs through Effect's `Toolkit.handle`, which records the call's arguments as sent on
  the current span, as `parameters`, a `Schema.Redacted` field's value included, as in 0.8.0;
  HTTP records no request body. Where a tracer exports spans, keep an action that takes a
  secret off tools ([observability](docs/guarantees.md#observability)).
- guarantees.md's wire table gives MCP's answers to a body that is not JSON, a JSON-RPC
  `Parse error` (`-32700`) with 200 over HTTP and none over stdio, to a missing or non-JSON
  content type, an empty 415, to another HTTP method on the endpoint, an empty 405 with
  `Allow: POST`, and to an unknown tool, a JSON-RPC `-32602` error, with 200 over HTTP.
- ActionMcp.md adds a rule: closing stdin interrupts every call in flight, and `runStdio`
  succeeds once they have stopped, after any uninterruptible region has completed. An
  interrupted call gets no result: no answer, or a JSON-RPC error. MCP hosts close stdin to
  shut a server down; a script piping requests keeps stdin open until it has read every
  answer.
- The docs and examples provide a command's services and caller on the command,
  `Command.provide(Users.layer)` and `Command.provideSync(CurrentActor, actor)`, built or read
  when the command runs, before its input is decoded, so input the action's schema refuses is
  refused after they are built; `--help` and the parser's errors, such as a missing or unknown
  flag, never build them. Provided around the run, as 0.8.0 showed, they are built before the
  arguments are parsed. A remote command's connection is configured on the command too, with
  `client` or, for settings read when it runs, `Command.provideEffect(HttpClient.HttpClient, ...)`,
  so no other request of the program takes its URL or credentials. `make`'s aggregate run alone still builds its provisions before
  showing its help, and fails instead if one fails.
- The docs state what a message for input that does not decode says on every surface: what
  the schema expects and, where Effect's decoder reports one, each issue's path, never a value
  sent; a path names the keys it passes through, a record's included
  ([guarantees.md](docs/guarantees.md#wire-behavior)).
- The skill, read from the repository whatever version a project installs, sends an agent in
  a project that installs the package to that version's own pages in node_modules, and shows
  the module its snippets import for the identity and the hook. The routing table says when to
  read each page, CONTEXT.md included, and CONTEXT.md defines a layer graph, a share and its
  source, and startup services.
- The examples implement the agent-only `listChanges` beside the other user actions, which
  HTTP's binding leaves out, and document the bearer scheme in the OpenAPI document.

## 0.9.0

Built and tested against `effect` and `@effect/platform-node` `4.0.0`, the first stable
release of Effect 4. The `effect` peer is now `^4.0.0`.

### Breaking changes

**The `effect` peer requires Effect 4.0.0 or a later 4.x release.** Release candidates no
longer satisfy it. Nothing in this package's API or behaviour changed.

- Migrate: install `effect` and `@effect/platform-node` `4.0.0` or later. Effect's own 4.0.0
  release notes list its changes since rc.118; this package needed none of them.

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
