# Changelog

## 0.10.0

One contract, one implementation, one rule for who may call. `ActionGroup` is gone: a contract
states who may call it, `caller: Action.Anyone` or the identity a caller must have, and every
surface enforces it; `Action.implement` binds handlers to actions, behind the `authorize` an
implementation of protected actions states, on every surface. Authentication is a named,
browser-safe descriptor the binding names and a server-only verifier, enforced and documented as
native endpoint security, before any body is read. HTTP binds a flat list of actions, and one layer
serves the public and the protected ones; one MCP endpoint serves signed-out and signed-in callers.
Every client calls an action with its input, and `Action.client` calls implementations in process,
which is how their behavior is tested. Every endpoint and tool declares the built-in `InvalidInput`
(400), `Unauthenticated` (401) and `Forbidden` (403). A builder runs once per layer graph, each call
has a scope of its own, and a request's own values win over startup ones. CLI flags come from each
action's input, and a command runs on Effect's own `NodeRuntime.runMain`, printing a failure on
stderr as the JSON HTTP sends. The client modules merge into `ActionHttp` and `ActionCli`, clients
and `Testing` are Effect-only, and `ActionCatalog` and `TestingClient` are removed. `access` becomes
`readOnly`, `mcp` takes MCP's own hint names, and stdio also serves 2025-11-25 and 2025-06-18, so
Claude Code and Codex connect. The docs say where builders and your own services are built.

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
const GetUser = Action.make("getUser", { ..., readOnly: true, caller: CurrentActor });
const users = Action.implement([GetUser, RenameUser], build, { authorize });
const Login = Authentication.make("app.Login", CurrentActor);
const Http = ActionHttp.make([GetUser, RenameUser], { authentication: Login });
const authenticate = Authentication.layer(Login, verify, { protectedResource });
ActionHttp.layer(Http, users).pipe(Layer.provide(authenticate));
const ReadPage = Action.make("readPage", { ..., caller: CurrentActor, mcp: { text: "markdown" } });
const pages = Action.implement(ReadPage, read, { authorize });
ActionMcp.layerHttp([users, pages], { name, version, authentication: Login }).pipe(
  Layer.provide(authenticate),
);
```

Each area below lists what is renamed or removed, then what changes without a rename.

#### Contracts

| 0.8.0                                                                     | 0.10.0                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access: "read"`, `access: "write"`, `action.access`, `Action.Access`     | `readOnly: true`, `readOnly: false`, `action.readOnly`, a boolean kept as its literal; the span and log attribute `action.access` becomes `action.read_only`, a boolean                                                                                                             |
| `mcp.destructive`, `mcp.idempotent`, `mcp.openWorld`                      | `mcp.destructiveHint`, `mcp.idempotentHint`, `mcp.openWorldHint`: MCP's own names, each left out MCP's default, but a read-only action's `destructiveHint`, which is `false`                                                                                                        |
| `action.mcp`, `Action.McpOptions`                                         | `action.mcp`, the options as given, without defaults, `Action.Mcp`                                                                                                                                                                                                                  |
| `mcp.name`                                                                | The action's name, which is the tool's: `get_user` becomes the tool `getUser`, so update hosts' allowed tools and prompts. To keep a tool's name, give it to the action, which also names its route, client method and command                                                      |
| `mcp.readOnly`                                                            | The contract's `readOnly`: a tool is read-only exactly when its action is                                                                                                                                                                                                           |
| `mcp: false`                                                              | Leave the action out of the `actions` option of `ActionMcp.layerHttp`, `runStdio` and `ActionToolkit.make`: list the actions that are tools beside the contracts, `actions: Tools`, and an action added later is no tool until it is listed ([Action.md](docs/Action.md#contracts)) |
| `errors: [UserNotFound]`, `action.errors`                                 | `error: UserNotFound` or `error: [UserNotFound, Conflict]`, as `HttpApiEndpoint` takes it; `action.error`, always a list                                                                                                                                                            |
| `Action.Codec`                                                            | `Action.Any["input"]`                                                                                                                                                                                                                                                               |
| `Action.Action`'s `Mcp` type parameter, `Action.Options`' type parameters | `Action.Action<Name, Input, Success, Errors, ReadOnly, Caller>`; `Action.Options` has none                                                                                                                                                                                          |

- Every contract states who may call it, `caller`: `Action.Anyone`, or the identity service a caller
  must have, such as `caller: CurrentActor`. Without it `make` does not compile, and from plain
  JavaScript throws `Missing caller: declare Action.Anyone or an identity service key`. 0.8.0 left
  this to whichever layers the host wrapped in authentication. Every surface now enforces it,
  whatever the handler reads: remotely through the binding's or endpoint's authentication
  descriptor, locally by owing the identity per call. Give `caller: Action.Anyone` to an action
  0.8.0 served without authentication or a hook, and the identity its hook or handler read to every
  other. The module declaring the identity, a `Context.Service`, stays free of server code:
  contracts import it.
- `Action.make` throws `Invalid action name: <name>` for a name over 128 characters, which 0.8.0
  refused only as a tool name: shorten it. Its types refuse an unknown `mcp` key, such as a
  misspelling or `readOnlyHint`, and options typed by a helper's type parameter: type that
  parameter `Action.Mcp`. A `readOnly` that is not a boolean throws `Invalid readOnly: <value>`.

#### Implementations and authorization

| 0.8.0                                                                                        | 0.10.0                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionGroup.make(...)`, `Group.implement(build)`                                            | `Action.implement(actions, build, { authorize })`, `{ authorize }` only for protected actions                                                                                               |
| `ActionGroup.Implementation`; `Group`, `Any` and `Options`                                   | `Action.Implementation`, inferred, never spelled out: a helper takes implementations as a type parameter ([Action.md](docs/Action.md#rules)); a group is a list of actions                  |
| `ActionGroup.contracts(...groups)`, `Contracts`                                              | `Action.byName(actions)`, the list keyed by name, each its exact contract; the list itself is the actions, or a binding's `Http.actions`                                                    |
| `app.group`                                                                                  | `app.actions`, its exact contracts                                                                                                                                                          |
| `app.build`                                                                                  | `Action.client(app)`, then `client.<action>(input)`: its handlers behind its authorization, in process, the methods `ActionHttp.client` has; a surface's own behavior under `Testing.layer` |
| A group's `errors`                                                                           | One array spread into each action's `error`; `ActionHttp.make(actions, { error })` for router middleware's; authentication's refusals are built in                                          |
| A group's `schemaError`, `SchemaErrorPolicy`, `SchemaErrorAnswer`                            | Nothing: input that does not decode is the built-in `Action.InvalidInput`, and a success that does not encode is a defect, an empty 500                                                     |
| `before` of `Http.layer`, `ActionMcp`, `ActionToolkit.make`, `ActionCli.command` and `group` | `Action.implement(actions, handlers, { authorize })`, for an implementation of protected actions                                                                                            |
| A hook failing with the surface's `errors`; `errors` of `ActionMcp` and `ActionToolkit`      | An authorizer failing with an `Action.Refusal` only; a limit is the handler's, failing with an error its action declares                                                                    |
| `before`'s `action`, an `Action.Any`                                                         | `authorize`'s `action`, typed as the implementation's own actions, in a built authorizer too                                                                                                |
| Span `<group>.<action>`, attribute and log annotation `action.group`                         | Span `<action>`                                                                                                                                                                             |

- An implementation of protected actions states who of the authenticated callers may call:
  `{ authorize }` is required, and `Action.allowAll` lets every authenticated caller call. An
  implementation of public actions alone takes none. In 0.8.0 `before` was an option of
  `Http.layer`, `ActionMcp.layerHttp` and `layerStdio`, `ActionToolkit.make`,
  `ActionCli.command` and `ActionCli.group`, and leaving it out meant no authorization. Pass it
  to `implement` instead; where 0.8.0 passed none, make the contract public, or pass
  `{ authorize: Action.allowAll }`. Where it guarded one surface and not another, decide per
  action: the contract is public, or the caller of the unguarded surface is a trusted identity
  the host supplies there, which the same `authorize` admits
  ([ActionCli.md](docs/ActionCli.md#trusted-callers)). Without `authorize`, `implement` of a
  protected action does not compile, naming `ProtectedActionsTakeAuthorize`, and from plain
  JavaScript it throws `Protected actions require authorize, or Action.allowAll`. `undefined`
  is not an authorizer: `before: enabled ? authorize : undefined` becomes
  `{ authorize: enabled ? authorize : Action.allowAll }`.
- `authorize` runs only for protected actions, after authentication and input decoding, and fails
  only with a refusal. A limit is the handler's: the action declares its error in `error`, so
  every surface declares it and every client decodes it, the builder yields the limiter, a startup
  service every surface of the layer graph shares, and the handler fails with the error before its
  work ([Action.md](docs/Action.md#implementations)). 0.8.0's hook failed with its surface's
  `errors`, which that surface alone declared, and a CLI's with any error: move a limit into the
  handlers of the actions it applies to, declaring its error on each, or keep a limit applied
  before decoding in HTTP middleware, router middleware or the layer's own, with
  `ActionHttp.make`'s `error`.
- One action takes its handler, and a builder for it returns the handler, not a record: a
  one-action group's `.implement({ greet: handler })` becomes
  `Action.implement(Greet, handler)`, with `{ authorize }` for a protected action. A list
  takes a record keyed by action name, as a group did.
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
- Each call has a scope of its own, on every surface: what an authorizer or a handler
  acquires is released when the call ends, the handler's first, and a fiber it forks with
  `Effect.forkScoped` is interrupted. In 0.8.0 a Toolkit call made with `tools.handle`, or
  approved through `LanguageModel`, held it until its caller's scope closed, so with a pooled
  connection per call, a third call on a pool of two waited forever. Over HTTP, a handler's
  finalizers now run before the route middleware around it resumes, and before the success
  is encoded, rather than when the request's scope closes. A resource that must outlive a
  call belongs to the builder, or to a service the host provides around its calls. `Scope`
  is never a request-time requirement: `runStdio`, a Toolkit tool, `tools.handle` and
  `LanguageModel.generateText` need no `Effect.scoped` for a handler that acquires; drop one
  added only for the types.
- `make` refuses an `error` entry encoding with a built-in `_tag`, behind `Schema.suspend`
  or among a union of `_tag` literals or an enum's values too. So does `ActionHttp.make` for
  such an entry in a binding's `error`, the built-in itself included: it throws
  `ActionHttp binding: error _tag "Unauthenticated" is built in, and declared on every surface`
  though `make`'s types accept it. Drop the `Unauthenticated` and `Forbidden` 0.8.0 declared in
  `ActionHttp.make`'s `error` for the authentication's 401 and the authorizer's 403: every endpoint
  declares the built-in ones. Replace an `Unauthenticated` or `Forbidden` of your own with the
  built-in one, in authorizers and handlers too. One kept there still compiles, since its `_tag` and
  `message` match the built-in's. It is then sent as the built-in without its other fields, so
  0.8.0's example's `permission` would be lost. Use
  ``new Action.Forbidden({ message: `Requires ${permission}.` })``, adding `scopes` only for
  OAuth scopes.
- `Action.make` refuses an error in `error` that encodes with a built-in error's `_tag`, and
  `ActionHttp.make` one in the binding's: checked where the contract or binding is made, so a
  client of a contract no server of this package serves cannot decode a look-alike as a
  built-in error either. Errors of your own may share a `_tag`, told apart by their other
  fields as the members of any union are. A top-level
  `Schema.suspend` in `error` is resolved then: one whose thunk reads a `const` declared later
  throws a `ReferenceError` at `make`.
- A helper passing implementations it is given beside its own takes them as one type parameter,
  `<const Apps extends ReadonlyArray<Action.AnyImplementation>>(apps: Apps)`, and spreads it,
  `[...apps, double]`, or takes one, `<App extends Action.AnyImplementation>(app: App)`, and
  lists it, `[app, double]`, as 0.8.0's `Http.layer([app, double])` took it. A value typed
  `Action.AnyImplementation` owes `unknown`, on every surface's layer.
- An implementation is served and called only by the installed copy of the package
  whose `Action.implement` made it. Another copy's surfaces, `Action.client` and `Action.layer`
  throw
  `Not an implementation made by this Action.implement: is effect-actions installed twice?`,
  a local CLI command when it runs, where 0.8.0 served it. Install one copy. Contracts and
  bindings still cross copies.

#### HTTP

| 0.8.0                                                                                  | 0.10.0                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ActionHttp.make({ apiPath, errors }, ...groups)`                                      | `ActionHttp.make(actions, { prefix?, error?, authentication? })`: `prefix: "/api/users"` keeps `/api/users/getUser`; `authentication` is required for a protected action                                                                                                 |
| The `ActionHttp.Http` type, `Http.groups`                                              | `ActionHttp.Binding`, `Http.actions`                                                                                                                                                                                                                                     |
| `ActionHttp.Api`, `ActionHttp.LayerOptions`                                            | `typeof Http.api`; `ActionHttp.LayerOptions` is now `layer`'s `middleware`                                                                                                                                                                                               |
| `Http.layer(implementations, { before })`                                              | `ActionHttp.layer(Http, implementations, { middleware? })`, with the binding's authentication provider: `.pipe(Layer.provide(authenticate))`                                                                                                                             |
| A group left out of `ActionHttp.make`, implemented apart, to keep its actions off HTTP | The actions left out of `ActionHttp.make`, implemented with the others                                                                                                                                                                                                   |
| `Http.openApi()`                                                                       | `HttpRouter.add("GET", path, HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)))`, the route 0.6.0's `openApi` replaced: `Http.api` is native                                                                                                                      |
| `ActionCatalog`                                                                        | `OpenApi.fromApi(ActionHttp.make(actions).api)` of the actions to describe, offline. A binding no layer serves may hold actions HTTP leaves out, such as a tool for agents, which `Http.api` omits. Or use an MCP endpoint's `tools/list`. Hints are each action's `mcp` |
| `HttpApiClient.make(Http.api)`'s `client.users.getUser({ payload })`                   | `ActionHttp.client(Http)`'s `client.getUser(input)`; natively `client.getUser({ payload })`                                                                                                                                                                              |
| `ActionHttpClient.promise(Http, options)`                                              | `ActionHttp.fetchClient(Http, options)`, built once, each call `Effect.runPromise`d ([ActionHttp.md](docs/ActionHttp.md#promise-callers)), the wrapper 0.6.0's `promise` replaced: clients are Effect-only                                                               |
| `ActionHttpClient.Client`, `Method`, `Options`                                         | `ActionHttp.Client`, `ActionHttp.ClientOptions`; `fetch` is `fetchClient`'s option, or `FetchHttpClient.Fetch` around `client`                                                                                                                                           |

- Routes are `POST <prefix>/<action>`, `/api` by default, with operation ID `<action>`, so
  action names are unique per binding; 0.8.0's were `POST <apiPath>/<group>/<action>`, with
  operation ID `<group>.<action>`. The OpenAPI tag is the mount path, such as `api/users`, or
  `/` at the root, rather than the group's name.
- `ActionHttp.layer` serves the binding's actions among the implementations it is given. An
  implementation's other actions, such as a tool for agents, get no route, and their names are not
  checked. This reverses 0.7.0's way to keep an action off HTTP, a group of its own that the binding
  left out, since `Http.layer` refused an implementation of any other group
  (`Implementation of group "x" is not served by this adapter`): such an action took an
  implementation of its own, its builder and hook repeated. An implementation holding none of the
  actions served is left out and not built, so one list serves each area's binding; implementations
  holding none of the binding's actions at all are refused, as the wrong ones, when `layer` is
  called: `No action of these implementations is in this HTTP binding: x`. Two implementations of
  one served action throw `Duplicate served action: <name>`, where 0.8.0 threw
  `Duplicate implementation group: <group>`; actions the binding leaves out may repeat. A layer owes
  per request its implementations' authorizers and the handlers of the actions it serves.
- One layer serves a binding's public and protected actions, from one implementation or
  several: a protected route is authenticated by the binding's descriptor, through the
  provider the layer requires, before anything reads its body, so it answers 401 before a 415
  or a 400; a public route ignores credentials. 0.8.0 authenticated whatever layer the host
  wrapped, public and protected actions in separate layers: merge them into one
  ([ActionHttp.md](docs/ActionHttp.md#rules)). A test or a raw request asserting a 415 or a 400
  on a protected route sends a token.
- The OpenAPI document states each protected operation's security requirement, from the
  descriptor's native security middleware, the one that enforces it, and a public one's
  `security: []`; 0.8.0 stated none. Its scheme is keyed by the descriptor's name as it is,
  `example.Login`, so distinct descriptors never share a key in one combined document. A name
  is an OpenAPI component key, letters, digits, `_`, `.` and `-`: `make` throws
  `Invalid authentication name` for any other, such as `example/Login`.
- Every endpoint declares its action's errors, its binding's, and the three built-in ones, and every
  tool its action's and the three. Any handler may fail with the built-in ones unlisted. Input that
  does not decode, malformed JSON included, is a 400 `InvalidInput` carrying the schema's message
  and its `issues`, each a `path` into the input and a `message`, which a handler refusing input
  that decodes may name too, so an application's own error for bad input, kept for its structured
  issues, is deleted; and a result that does not encode is an empty 500; 0.8.0 answered both with an
  empty 400, or with its group's `schemaError` answers. Nothing replaces `schemaError`: input needs
  no error of your own, since every surface declares `InvalidInput`, and a success that does not
  encode means the handler broke its contract after it ran, so any write it made has already
  happened, which a declared error would misreport. Defects, crashes and proxies send a 5xx without
  a declared body anyway. Delete the policy, and its `internal` error unless a handler fails with
  it.
- A declared error without an `httpApiStatus` is sent as 422, not 500; a union without one
  sends each member at its own. Annotate `{ httpApiStatus: 500 }` to keep the old status.
- `ActionHttp` answers a request without a content type with 415, as an MCP endpoint does;
  0.8.0 read it as JSON. A page on any origin can send such a body, with the caller's cookies,
  without a CORS preflight. The library's clients send `Content-Type: application/json`; a raw
  caller adds it. A route's payload is JSON whatever encoding its input is annotated with, such
  as `HttpApiSchema.asFormUrlEncoded()`, which `HttpApi` would accept as a form body, sent
  without a preflight too, and no other surface reads; the binding's client sends JSON.
- On `ActionHttp` and `ActionMcp`, a value a request gets from authentication,
  `HttpRouter.provideRequest` or other router middleware wins over one the routes were built
  with under the same tag, as on native routes and in a Toolkit call; a startup value only
  fills in one the request lacks. 0.8.0 let the startup value win: an identity provided at a
  server's root replaced the authenticated caller, and routes built inside a span parented
  their action spans to it. A protected action's identity is no longer such a value: only its
  authentication provider gives it, and nothing provided at startup or per request satisfies
  a layer serving it. A value provided around `HttpRouter.serve` or the program is the
  request's too, so it also wins over one provided to a single surface's layer, which 0.8.0
  let override it there; scope such a value with `HttpRouter.provideRequest`. Still never
  provide an identity at startup: a public handler or a route of the host's own reading it
  would serve every caller as it.
- A typed client drops an undeclared input field when it encodes, nested ones too, instead of
  failing with `SchemaError` before sending: `ActionHttp.client`, the native `HttpApiClient` on
  `Http.api`, and `Testing.mcpClient`. This reverses 0.8.0's "Typed HTTP clients fail with
  `SchemaError` on an undeclared field": TypeScript lets a wider value through, so a call the
  compiler accepted failed. The server still refuses the field from a raw caller: HTTP with a
  400 `InvalidInput` naming its path, MCP as invalid arguments. No call needs changing; to
  assert the refusal, send a raw request.
- A client's argument may be omitted exactly when `{}` is a valid encoded input, and then sends
  the input `{}` decodes to, so an input class whose fields are all optional, or have decoding
  defaults, may be left out; an input that decodes from fields `{}` lacks needs its argument. A
  given argument is sent as given; 0.8.0's Promise client sent `{}` for `undefined` or `null`.

#### Authentication

| 0.8.0                                                                            | 0.10.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authentication.middleware(tag, authenticate).layer`                             | The descriptor `Authentication.make("app.Login", tag)`, named by the binding and every MCP endpoint serving protected actions, and its provider `Authentication.layer(Login, verify, { protectedResource })`, provided to their layers, where `verify` takes the credential Effect's native scheme decodes and may fail with a refusal; a session cookie, an API key or Basic is the descriptor's one scheme, `{ security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }) }` |
| `Authentication.ProtectedResourceOptions`, `BearerChallengeOptions`              | `Authentication.ProtectedResource`, `layer`'s `protectedResource`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Authentication.protectedResource`: its `layer`, `metadataUrl` and `challenge()` | `layer`'s `protectedResource`, which publishes discovery and names its URL in every challenge; outside the router, `Authentication.refusal`                                                                                                                                                                                                                                                                                                                                            |
| A 401 challenge naming a scope                                                   | `scopesRequired` in the protected resource                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| An insufficient-scope error of your own and a hand-built challenge               | `new Action.Forbidden({ message, scopes: [scope] })`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Middleware provided around a layer to authenticate it                            | The contracts' `caller` decides, and the layer requires the provider: a protected action is authenticated on every layer serving it, a public one on none                                                                                                                                                                                                                                                                                                                              |
| Middleware reading the identity, after authentication                            | `ActionHttp.layer(Http, apps, { middleware: [LogCaller] })`, native `HttpApiMiddleware`; over HTTP only                                                                                                                                                                                                                                                                                                                                                                                |

- A descriptor covers action endpoints alone: an `HttpRouter.add` route that sat under 0.8.0's
  middleware takes `Authentication.protect(Login)`, router middleware authenticating it with the
  same provider, `route.pipe(Layer.provide(Authentication.protect(Login).layer))`
  ([Authentication.md](docs/Authentication.md#a-route-of-your-own)).
- `make` is a browser-safe declaration: its name literal identifies the one provider that satisfies
  it, so a provider of another descriptor of the same identity does not. It names one native
  `HttpApiSecurity` scheme, Bearer unless `security` gives another, such as a session cookie,
  `HttpApiSecurity.apiKey({ in: "cookie", key: "session" })`, or `HttpApiSecurity.basic`; a record
  of schemes, or anything else, throws `Authentication takes one native HttpApiSecurity scheme`, and
  the types refuse it, as they do a misspelled option; its options type is
  `Authentication.Options`, and options that may leave `security` out type the credential as
  that scheme's or Bearer's. OAuth is Bearer's: only a Bearer descriptor's provider takes a
  `protectedResource` (another scheme's throws
  `A protected resource is published only for a Bearer scheme`), and only under one does a protected
  action's refusal step up; over HTTP it answers the refusal as it leaves a layer's `middleware`,
  which may recover from it or turn it into an error the binding declares, and a public route's or
  public tool's never steps up, signed in or not. Another scheme's 401 carries the challenge it has,
  an `Http` scheme naming itself, Basic `Basic realm="<descriptor name>"`, an API key none; its
  other refusals are their JSON and status over HTTP, and an `isError` tool result over MCP.
- A verifier receives the credential Effect's native scheme decodes: a `Redacted` token or key,
  or Basic's credentials, presented when its user-id or its password is non-empty, so a token
  sent as the password reaches it. An empty one, as the native decoder gives for one absent or
  malformed, never reaches it; its 401 says `A bearer token is required.`, or
  `A credential is required.` for another scheme. Its type is `Authentication.Verify`.
- On a protected route, or any route of an MCP endpoint naming a Bearer descriptor,
  `Unauthenticated`, or a `Forbidden` naming `scopes`, from authentication, an authorizer or a
  handler, is answered with its HTTP status, challenge and JSON, on MCP too instead of a tool
  result, as MCP authorization defines. If an MCP handler's notification has already started the
  response, a later refusal remains a tool error in that stream. Elsewhere, such a refusal is a
  declared error. A defect or an interruption after such a refusal, such as a finalizer dying, is
  the route's own, answered as one, not hidden behind the refusal's answer.
- Every 401 a Bearer descriptor covers without a challenge gets a `Bearer` one, naming
  `scopesRequired` and the metadata URL of a protected resource, and `invalid_token` when the
  request presented a bearer token, a malformed one such as `Bearer a b` included (RFC 6750
  §3.1). 0.8.0 left each 401 as the host rendered it.
- `layer`'s second argument is the verifier, or a builder of it, as `implement`'s may be: what
  a builder yields is a startup requirement of the provider's layer, built once per layer graph
  (`Authentication.layer(Login, build).pipe(Layer.provide(Verifier.layer))`), and it returns
  the verifier. What a verifier yields beyond the request is a request requirement, which
  native router middleware provided after the authentication supplies, in a `Layer.provide` of
  its own: `routes.pipe(Layer.provide(authenticate), Layer.provide(resolveTenant.layer))`. One
  array, `Layer.provide([authenticate, resolveTenant.layer])`, leaves it owed. 0.8.0's
  `authenticate` had no startup phase: every service it yielded was a request requirement.
- Nothing but the provider supplies a protected action's identity to a remote surface: an
  identity provided at startup, per request with `HttpRouter.provideRequest`, or around
  `Testing.layer`, no longer satisfies a layer serving one. A test serves its routes behind the
  real provider, or a test verifier of the same descriptor, and gives each client its token
  ([Testing.md](docs/Testing.md#signed-in-callers)).
- A protected resource's discovery is published by the provider's layer, once per layer graph,
  however many layers it is provided to, where 0.8.0's `discovery.layer` was merged beside the
  routes. It carries `Access-Control-Allow-Origin: *` and answers its own CORS preflight (204,
  allowing `GET`, `HEAD` and `OPTIONS` and the requested headers), so a browser MCP client
  reads it after a 401. Where the host's CORS middleware runs first, its policy answers
  discovery's preflight and adds its headers to discovery's reads, which keep the `*` where it
  sets no origin.
- Authentication keeps a route's own `Cache-Control`, which 0.8.0's `middleware` replaced with
  `no-store`; every other response to a request it authenticates, and a failure enclosing middleware
  serializes, is still `no-store`. An MCP endpoint's answer to an anonymous request, discovery, its
  listing or a public tool's call, gets none, as a public HTTP route's does. A route stating its own
  says `private` unless its answer is the same for every caller: a credential a proxy forwards is
  invisible to a cache in front of that proxy.

#### MCP

| 0.8.0                                                                              | 0.10.0                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionMcp.Options<Errors, R>` of `layerHttp`, `ActionMcp.StdioOptions<Errors, R>` | `ActionMcp.LayerHttpOptions<E, R>`; `ActionMcp.Options<E, R>` is the server's, which `layerHttp` and `runStdio` both take; `E` and `R` are its `features`' |
| `Layer.launch(ActionMcp.layerStdio(implementations, options))`                     | `ActionMcp.runStdio(implementations, options)`, which succeeds when the host closes stdin                                                                  |

- An endpoint serving a protected action names its descriptor, `authentication: Login`, and requires
  its provider. One endpoint serves public and protected tools on one URL: discovery,
  `server/discover` and `tools/list`, and a public tool's call pass without a credential, or with
  one the scheme decodes as empty, a credential they present is verified, and refused with 401 if it
  does not verify, as MCP authorization requires, and every other request authenticates before the
  endpoint reads its body, a protected tool's call and every native feature's request, listings,
  completions and subscriptions included. An endpoint of protected tools alone authenticates every
  request. 0.8.0 authenticated whatever endpoint the host wrapped, and kept public tools on an
  endpoint of their own: merge them, or keep two endpoints to leave the protected tools unlisted to
  signed-out callers ([ActionMcp.md](docs/ActionMcp.md#rules)). The routing headers decide as they
  are: a Base64-encoded tool name names no public tool, and authenticates. A protected tool's call
  without a credential is a 401 before its arguments are decoded, malformed ones included, on a
  mixed endpoint too. A public tool never gets an identity, and a public prompt or resource beside
  protected tools takes an endpoint of its own.
- `runStdio` takes no `authentication`: the host provides the identity of its protected tools
  around it.
- `runStdio` gives its program a `Console` whose every method writes to stderr, so console loggers
  such as `Logger.consoleJson`, `Console.log`, and the counters, timers and group labels Node's
  console prints on stdout never corrupt the protocol from its builders, authorizers and handlers. A
  counter or a timer prints its label and its count or the milliseconds since it started, a group
  prints its label without indenting what follows, and `clear` does nothing. Layers provided around
  it run outside its program: apply `ActionCli.onStderr` last, before `runMain`, in place of 0.8.0's
  `Logger.LogToStderr` outermost, `disableErrorReporting` and `tapCause` block. It moves their
  default logger to stderr, and reports there what `runMain` would report on stdout, but does not
  move their `Console` output or `Logger.consoleJson`: log JSON there with
  `Logger.withConsoleError(Logger.formatJson)`.
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
  `Testing.mcpClient`, reading the same `text`, does. Every other surface serves the whole
  success. `text` is typed by `make`: a top-level string field of the encoded success,
  optional or not, which a scalar, array, union or record success does not have.
  0.8.0 accepted a union member's field, or any name for a record, and then failed the layer
  build. Where the types cannot tell, as for an erased success or a union of one struct,
  `layerHttp` and `runStdio` throw when called, naming every such action:
  `MCP tool text field must be a top-level property of its success: <name> ('<field>')`.
  Make such a success one struct, or drop `text`.

#### Toolkit

| 0.8.0                                                                    | 0.10.0                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionToolkit.Binding<Tools, E, R>`, `ActionToolkit.Options<Errors, R>` | `ActionToolkit.Tools<T, E, R>`, the same `{ toolkit, layer }`, each type argument required; `ActionToolkit.Options<A>`, over every action of the implementations, holds `actions` and `needsApproval` |

- A Toolkit tool takes and gives JSON, as MCP's does: `tools.handle` takes JSON arguments, and
  a tool's schemas are `Schema.toCodecJson` of the action's. 0.8.0 decoded a model's JSON with
  the action's schemas, refusing an ISO string for a `Schema.Date`. Pass `tools.handle` the
  JSON a model sends, such as that ISO string.
- A Toolkit tool belongs to its implementation. Two implementations with tools of one name,
  such as two of one action behind different authorizers, never run each other's
  handlers, their layers provided together in either order; 0.8.0 found a tool's handler by
  its name alone, so one layer answered every toolkit's tool of that name, behind that
  layer's own `before`. The `layer` of any `make` call serves the tools of its
  implementations in any `toolkit`, an agent's fewer tools included, so toolkits made per agent
  or per approval policy run with one
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
| A command failing with the action's failure itself: `Effect.catchTag("UserNotFound", ...)` after `Command.run`                   | `ActionCli.Failure<E>`, Effect CLI's `CliError.UserError` whose `cause` and `reason` are the failure: `Effect.catchReason("UserError", "UserNotFound", ...)`, Effect's own                                                                                                                                                                                                                                                                          |
| `Effect.tapCause(...)`, `Logger.LogToStderr` and `NodeRuntime.runMain({ disableErrorReporting: true })` around `Command.runWith` | `Command.run(cli, { version })` on `NodeRuntime.runMain`, after `ActionCli.onStderr` where stdout feeds scripts (below)                                                                                                                                                                                                                                                                                                                             |
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
  and an optional one is left out; a `Schema.NonEmptyArray` field's flag is required once. An
  occurrence of `[]` adds no element, so `--tags '[]'` alone sends `[]`, clearing an optional
  field. An array field listed last in `positional` takes the same values as repeated
  arguments, `rm a b`; listed before another, it throws
  `Repeated positional argument before another one: <field>`. Any other array takes JSON.
- A command whose action fails prints the failure on stderr as the JSON HTTP sends for it, such
  as `{"_tag":"UserNotFound","id":"9"}`, through Effect's CLI formatter, and exits 1, or with
  the failure's `Runtime.errorExitCode`. It fails with Effect CLI's `UserError`, whose `cause`
  is the action's failure, which `Command.run` prints and marks reported, so `runMain` does not
  print it again. 0.8.0 failed the command with the action's failure itself, which `runMain`
  printed on stdout with a stack and without its fields, and the documented program printed the
  raw `Cause` on stderr instead; delete that block. A failure no schema encodes, a builder's or
  the transport's, prints as its tag, or an error's name, and its message, and each cause's, up
  to one already printed, never its other fields. `Command.run` prints a command's failure
  before a host's `Effect.catchReason("UserError", ...)` runs, so a host that recovered silently or
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
- What a command runs, the builder, authorizer and handler, or a remote command's client
  call, and the codecs of its input, success and failures, writes its Effect logs and `Console`
  output to stderr, whatever logger prints them, and the command writes only its result to stdout.
  0.8.0 wrote them to stdout unless the program provided `Logger.LogToStderr`, which moves only the
  default logger. The global `console.log` and other direct writes bypass Effect and still reach
  stdout: keep them off stdout. Layers the host provides, on the command or around the run, log
  outside the command, and `runMain` reports a defect, and a failure of such a layer, on stdout: a
  CLI whose stdout feeds scripts applies `ActionCli.onStderr` last, before `runMain`, which moves
  those layers' default logger to stderr and reports there what `runMain` would, with its exit code,
  but does not move their `Console` output or `Logger.consoleJson`
  ([ActionCli.md](docs/ActionCli.md#rules)).
- A local command's `Failure` includes `Action.BuiltIn`, whatever its implementation's authorizer.
- A protected action's command, a Toolkit tool and an `Action.client` method owe its identity
  per call, whether or not the handler reads it; one call without it anyway fails with
  `Unauthenticated` before `authorize` runs.

#### Testing

| 0.8.0                                                                                                                                     | 0.10.0                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Testing.httpClient(api, handler)`, `Testing.Handler`                                                                                     | `Testing.layer(handler)`: the native `HttpClient`, answered by the web handler, on which `ActionHttp.client(Http)` and every other client call it; `Testing.layer(routes)` builds the routes itself                                                                                                                                              |
| `Testing.mcpCall(handler, { url, name, arguments, headers })`, resolving `{ isError: false, value, text? }` or `{ isError: true, error }` | `Testing.mcpClient(actions, { url?, transformClient? })`, then `mcp.<action>(input)`: the decoded success, or a typed failure. An action with a `text` hint has its success read from its text blocks                                                                                                                                            |
| `Testing.mcpRequest({ url, method, params, headers })`, a `Request`                                                                       | `Testing.mcpRequest(method, params?, { url?, headers? })`, the native request: send it with `HttpClient.execute`, or as a web `Request`, `HttpClientRequest.toWebResult`                                                                                                                                                                         |
| `Testing.McpCallOptions`, `McpCallResult`, `McpRequestParams`, `McpRequestValue`                                                          | None: `mcpClient` types each call, and `params` are JSON                                                                                                                                                                                                                                                                                         |
| `TestingClient.withMcpClient`, `McpClientOptions`, the optional `@modelcontextprotocol/client` peer                                       | Depend on the official client, `new Client(info, { versionNegotiation: { mode: { pin: "2026-07-28" } } })`. Give its transport `fetch: (input, init) => web.handler(new Request(input, init))`, with `web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)))` as 0.8.0's tests built it; or use `Testing.mcpClient` |

### Additions

- `Authentication.make` refuses, in its types, a `security` that is no native scheme, such as a
  record of them, before the run time throws; `layer` refuses a `protectedResource` for a
  scheme other than Bearer the same way.
- `Action.make` refuses a `Context.Reference` as `caller`, in its types and at run time
  (`Invalid caller: an identity is a Context.Service, not a Context.Reference`): a reference is
  never missing, so its default would stand in for every caller who supplies none.
- `Action.implement` throws `A public-only target takes no authorize` when plain JavaScript gives
  `authorize` to public actions alone, which would never run, as its types already refuse.
- `ActionHttp.fetchClient(Http, { baseUrl, transformClient, fetch })` is `client` built once
  over `fetch`, outside an Effect: its methods are the same Effects and require nothing, so a
  browser app or a script runs each call with `Effect.runPromise`. A call sends with the
  `fetch` option, or with the global `fetch` as the call finds it, so a test's stub installed
  later is used. It replaces
  the three lines every Promise caller repeated around `client`: `FetchHttpClient.layer`,
  `FetchHttpClient.Fetch` and `Effect.runSync`.
- `Action.InvalidInput.fromSchemaError(error)` is the `InvalidInput` every surface answers a
  `Schema.SchemaError` with, its message and its `issues`, for code that decodes input of its
  own, such as a header or a route parameter, and answers as the surfaces do.
- `input` and `success` take plain fields: `input: { id: Schema.String }`. `input: {}`, or no
  `input`, is an action without input: a strict empty object, the root MCP needs. A given
  schema, `Schema.Struct({})` included, is kept as it is.
- `success` is optional: omitted, it is `Schema.Void`, and a CLI command prints nothing by
  default or with `--json`; a custom `render` may print text.
- An `undefined` option takes its default, as an omitted one does, and one that may be either
  is typed as either: `success: enabled ? Schema.String : undefined` gives `string | void`.
- `authorize` may be an Effect that builds it, as a builder builds handlers. What the Effect
  yields, such as a permission store, is a startup requirement, provided once beside the
  builders' services; what the authorizer it returns yields, such as the caller, stays per
  request. It is built once per layer graph for its implementation, and per invocation of a
  local command. A 0.8.0 hook that read a store owed it per request, supplied with
  `HttpRouter.provideRequest` on each surface: yield the store in the Effect instead, and
  provide its layer at startup. A 0.8.0 hook built in `Layer.unwrap` around a surface becomes
  that Effect, which `implement` builds once per implementation in each layer graph: build what
  several implementations or the surfaces share outside it. A service whose value is the
  authorizer, `{ authorize: Guard }`, is built once for every implementation it guards.
- `ActionHttp.layer(Http, implementations, { middleware })` runs native `HttpApiMiddleware`
  around every route it serves, inside authentication and outside decoding, the first listed
  innermost. It may require the identity where every action the layer serves is protected, and
  fails only with the binding's `error` or a built-in error, such as an address allowlist's
  `Action.Forbidden`, so a limit keyed by the caller runs before decoding; one after decoding,
  on every surface, is the handler's. It may fail with a binding error only where the binding surely
  declares it, in a slot of its own of a list of fixed length.
- `Action.client(implementations)` calls implementations in process: one method per action, taking
  its input directly, as `ActionHttp.client`'s methods do, so moving between an in-process and a
  remote caller changes the line acquiring it. A call runs as a remote one does, through the
  dispatch every surface shares: its input passes through its JSON codec, encoded to JSON text then
  decoded, the authorizer and the handler run in a scope of their own, and the success
  or the failure passes through its codec too. It fails with the action's errors and the built-in
  ones, as a remote caller decodes them: input that does not pass is `InvalidInput`, before the
  authorizer, and a success or a failure that does not, an error the action does not declare
  included, is a defect, as it is an empty 500 over HTTP: its `SchemaError`, then the failure
  itself. Each call owes what the authorizer and the handler read, the caller's identity
  included, provided around the call, never around the acquisition. Acquiring it builds the
  implementations into the layer graph around it, as a layer does, sharing each builder's run with
  the surfaces of that graph: acquire it in a builder, a layer or a scoped program, never per
  request. It is how an implementation's own behavior is tested, several callers in one test, an
  action no binding holds included; `Testing.layer` tests what a surface adds. `actions` lists fewer
  of their actions. `Action.Client<Apps>` is its type.

  ```ts
  const asAlice = Effect.provideService(CurrentActor, alice); // each call's caller

  Effect.gen(function* () {
    const users = yield* Action.client(userActions); // once, where builders live
    return yield* users.renameUser({ id: "1", name: "Bea" }).pipe(asAlice);
  });
  ```

- A binding states where it mounts, `Http.prefix`: `/api` by default, `/` at the root, without
  a trailing slash.
- The package declares `"sideEffects": false`, so a bundler may drop what a browser client
  does not use. Keep contracts and bindings in modules that import no server code
  ([setup.md](docs/setup.md#browser)).
- `scopesRequired` names the scopes every 401 of a protected resource asks for, so a first
  login requests the least rather than every scope supported.
- `Action.Forbidden` may name the OAuth scopes a call lacks, `scopes: ["users:write"]`. On an
  authenticated route it is a 403 with an `insufficient_scope` challenge, on which an MCP
  client re-authorizes and retries.
- `Authentication.protect(descriptor)` is native router middleware for a route of the host's
  own, such as an export, a page frame or a WebSocket upgrade: the descriptor's provider
  verifies the credential its scheme decodes and gives the route the identity, and the route is
  answered as an action's, its refusals and challenges, a `Forbidden` it fails with stepping up
  under Bearer, and `no-store` on every response to a request it authenticates.
- `Authentication.refusal(error, { authentication, protectedResource, authorization })` is the
  response authentication answers a refusal with: its status, JSON, `Cache-Control: no-store` and
  challenge. A caller the router never routes, such as a Node `upgrade` handler admitting a socket,
  refuses with it rather than building a challenge of its own
  ([Authentication.md](docs/Authentication.md#outside-the-router)). Given `authentication`, a
  descriptor of another scheme, it answers as that descriptor's routes do: its 401 names that
  scheme, and nothing steps up.
- `Authentication.bearerTokenOf(authorization)` reads an `Authorization` header value, an
  `Option` of the `Redacted` token, for that same caller, which holds the header and no
  request. It reads it as Effect's `HttpApiSecurity.bearer` does, the reading a Bearer
  descriptor's verifier receives: the whitespace around the value stripped, as HTTP parsers do,
  then the rest of the header after the scheme and its spaces, `a b` for `Bearer a b`.
- `Authentication.layer`'s `protectedResource` may be an Effect that builds it, as a builder
  builds the verifier: for a resource known only at startup, such as one read from a
  service. It runs once per layer graph.
- `ActionMcp.runStdio` serves MCP 2025-11-25 and 2025-06-18, beside 2026-07-28, as the host
  negotiates, so hosts that open with `initialize`, such as Claude Code and Codex, connect; a host
  asking for an earlier revision is offered 2025-11-25. This reverses 0.6.0's "Stdio hosts must
  speak 2026-07-28", which 0.7.0 kept on purpose for uniformity with HTTP, and which made 0.8.0's
  `layerStdio` refuse them. HTTP still serves 2026-07-28 only: Codex, which opens HTTP with
  `initialize` as well, connects over stdio ([ActionMcp.md](docs/ActionMcp.md#failure-modes)). MCP
  successes stay bare on every transport and revision, as in 0.8.0: on 2026-07-28
  `structuredContent` is the encoded success and the text content is its JSON. On the revisions
  0.8.0 refused, Effect's adapters decide what is structured: 2025-11-25 and 2025-06-18 carry only
  an object success as `structuredContent` and list only an object-rooted `outputSchema`. A success
  they do not structure is text alone, its JSON or, for a string success, the string itself, so a
  host on those revisions reads a non-object success from the text.
- `ActionHttp.layer`, `ActionMcp.layerHttp`, `runStdio`, `ActionToolkit.make` and `ActionCli.make`
  take `actions`, the actions they serve among the implementations', `ActionHttp.layer` among its
  binding's, so a mixed implementation's protected actions take identity middleware in a layer of
  their own without being split: each keeps its implementation's authorizer and its builder's one
  run, an implementation holding none is not built, and only the listed actions' inputs and names
  are checked for the surface. The types take only actions of the implementations, and owe only what
  the listed actions, and the builders holding them, need. A listed action none of them holds throws
  `Listed in actions, but no implementation holds it: <names>`. Omitted, every action is served, as
  before. `ActionCli.make` takes it from a binding too. Options whose `actions` may be absent, an
  optional property or a union with options lacking it, serve every action, so they owe what every
  action owes; `Action.client` gives such options methods, and `ActionToolkit.make` tools, only for
  the actions they may list. `needsApproval`'s `call` is typed by every action of the
  implementations, which a check of `call.name` narrows, so a reusable `ActionToolkit.Options` value
  is typed by all of them. An explicit type argument names the options' type, not the actions, and
  requires the options argument:
  `ActionMcp.layerHttp<typeof app, { readonly actions: readonly [typeof Status] }>(...)`.
  `ActionHttp.layer`, which takes options or none, reads `middleware` that may be absent the same
  way: such options owe what any of the middleware requires and provide nothing; a reusable value
  names its tuple, `ActionHttp.LayerOptions<readonly [typeof Audit]>`. `ActionHttp.make` reads
  `error` so: options that may leave them out declare them or none, as the binding has at run time,
  so clients decode them and no layer middleware may fail with them, and explicit type arguments
  naming `error` require the options argument; a layer middleware fails only with an error a fixed
  tuple slot of its own declares, never one of an array of unknown length or a slot of several.
  `make` takes public-only actions alone, or any actions with options: a helper forwarding options
  that may be absent passes `options ?? {}`. A misspelled option is a type error beside `actions`
  and `middleware` too, on every surface, each CLI command's options included.

  ```ts
  export const Tools = [GetUser, RenameUser] as const; // beside the contracts
  ActionMcp.layerHttp([users, pages], { name, version, authentication: Login, actions: Tools });
  ActionToolkit.make(users, { actions: Tools });
  ```

- `ActionCli.onStderr`, applied last before `runMain`, keeps stdout to a program's results: the
  default logger of every layer within writes to stderr, and what `runMain` would report on
  stdout, a defect or a failure of a layer the host provides, is reported on stderr once, with
  the exit code `runMain` gives, the defect standing for it carrying the original `Cause` as its
  `cause`. A command's failure `Command.run` printed is not reported
  again. An MCP subprocess applies it after `runStdio`.
- A command's `Failure` has a `reason`, its `cause`, so Effect's own
  `Effect.catchReason("UserError", "UserNotFound", f)` and `catchReasons` match an action's
  failure by its tag.
- `ActionMcp.layerHttp`'s `path` defaults to `/mcp`, where 0.8.0 required it.
- `ActionMcp.layerHttp` and `runStdio` take `features`, a layer of Effect's own
  `McpServer.resource`, `McpServer.prompt` and `McpServer.toolkit`, served beside the actions'
  tools on the same endpoint. Merged beside the endpoint instead, they register on another
  registry and are not served. A native tool of an action's name is refused when the endpoint
  builds, `Duplicate MCP tool: <name>, claimed by an action and a native feature`.
- `ActionToolkit.make(implementations, { needsApproval })` has `LanguageModel` ask for
  approval of a model's call before it runs, through Effect's native `Tool.needsApproval`:
  one rule over every call, `(call, context) =>` a boolean or an `Effect` of one, where
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

- A CLI flag's help text is its field's schema description, and a positional argument's label
  is its flag's, `value` for one taking JSON or text.
- `ActionCli.command` and `ActionCli.make`'s `commands` take `aliases`, a flag's short name by
  field, `{ aliases: { limit: "n" } }`, through native `Param.withAlias`.
- `mcp` takes `title` and `_meta`, an MCP tool's display title and its `_meta`, through native
  `Tool.Title` and `Tool.Meta`.
- `ActionMcp.layerHttp` and `runStdio` take the options' type as their second type argument,
  `<Apps, O, E, R, D>`, as `ActionToolkit.make` and `Action.client` do, and native `features`
  owe no `McpServer`, which the endpoint provides them.
- `Authentication.refusal` refuses what `layer` refuses, and both refuse a protected resource
  with a fragment, which discovery could never answer: `A protected resource has no fragment`.
- A suspended error keeps its `httpApiStatus` over
  HTTP. Layer middleware chosen by a condition within one slot provides nothing, so what one
  choice would provide stays owed.
- `Testing.mcpClient` reads tool results with the native `McpSchema.CallToolResult`.
- `Action` exports `BuildContext`, and `ActionHttp` `MethodError`, the types a surface's layer
  and a client's method are written in, so a package emitting declarations may export them.
- `Action.Handlers<typeof actions>` types a builder's record written apart from `implement`, as
  another authorizer of the same handlers takes, so each handler is typed from its contract.
- `Authentication` exports `Descriptor` and `Provider`, the types `make` and `layer` return, so
  a package emitting declarations may export a descriptor, a binding naming one and a provider.
- `ActionCli.make(target, { name, commands })` gives a subcommand the options `command` takes,
  by action name: `commands: { readFile: { positional: ["path"], render } }`. It takes any
  action of the target, so one record serves aggregates of several `actions`: a command of an
  action left out is unused, and a key naming no action of the target throws
  `Unknown commands: <keys>`.
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
  `Provider<CurrentActor, "example.Login">` among a layer's requirements, and
  `Type 'Provider<...>' is not assignable to type 'never'` where the server is launched,
  and why no identity provided at startup or per request stands in for it
  ([Authentication.md](docs/Authentication.md#failure-modes)).
- Authentication.md adds a rule: the verifier checks a token's audience, that it was issued for this
  `resource`, as MCP authorization requires (RFC 8707). `Authentication.layer` reads no token; one
  issued for another resource fails with `Unauthenticated`, as any token that does not verify.
- Authentication.md adds a rule: router middleware provided around routes runs before their
  authentication, and a check that must also cover discovery and unrouted requests, such as a
  Host or Origin policy, is global middleware, `HttpRouter.middleware(check, { global: true })`,
  merged beside the routes, as the example app's request policy now is.
- guarantees.md adds a rule: a handler maps another service's refusals before failing
  with them. An `Unauthenticated` or `Forbidden` that a client such as `ActionHttp.client`
  decodes is, passed on as it is, this server's own: on an authenticated route it sends a
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
  `Command.provide(Users.layer)` and `Command.provideSync(CurrentActor, actor)`, built or read when
  the command runs, before its input is decoded, so input the action's schema refuses is refused
  after they are built; `--help` and the parser's errors, such as a missing or unknown flag, never
  build them. Provided around the run, as 0.8.0 showed, they are built before the arguments are
  parsed. A remote command's connection is configured on the command too, with `client` or, for
  settings read when it runs, `Command.provideEffect(HttpClient.HttpClient, ...)`, so no other
  request of the program takes its URL or credentials. `make`'s aggregate run alone still builds its
  provisions before showing its help, and fails instead if one fails.
- The docs state what a message for input that does not decode says on every surface: what
  the schema expects and, where Effect's decoder reports one, each issue's path, never a value
  sent; a path names the keys it passes through, a record's included
  ([guarantees.md](docs/guarantees.md#wire-behavior)).
- The skill, read from the repository whatever version a project installs, sends an agent in a
  project that installs the package to that version's own pages in node_modules, and shows the
  module its snippets import for the identity and `authorize`. The routing table says when to read
  each page, CONTEXT.md included, and CONTEXT.md defines a layer graph, a public and a protected
  action, an authorizer, an authentication descriptor and its provider, and startup
  services.
- The examples implement the agent-only `listChanges` beside the other user actions, which
  HTTP's binding leaves out, serve public and protected actions from one HTTP layer and one MCP
  endpoint, and give an operator's CLI
  a trusted identity beside remote callers (`examples/cli-admin.ts`).

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
