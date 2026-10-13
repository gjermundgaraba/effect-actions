# Authentication failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
Tasks: [Authentication.md](Authentication.md),
[Authentication-advanced.md](Authentication-advanced.md).

## Types and startup

- `Provider<CurrentUser, "notes-service.Login">` among a layer's requirements,
  `Type 'Provider<...>' is not assignable to type 'never'` at `Layer.launch` or
  `NodeRuntime.runMain`, or `Expected 2 arguments, but got 1` at a web handler's
  `handler(request)`: a layer serving protected actions requires the provider of the descriptor
  it names. Provide it, `Layer.provide(authenticate)`. Nothing else satisfies it: not the
  identity itself, nor the provider of another descriptor, of the same identity or not
  ([Verify credentials](Authentication.md#verify-credentials)).
- `Authentication "<name>": the binding's descriptor is not its provider's`, a defect when
  `ActionHttp.layer`, `ActionRpc.layer`, `ActionMcp.layerHttp` or `Authentication.protect`
  builds: it names a descriptor built apart from the one `Authentication.layer` was given, such
  as the same options passed to `make` twice, or a browser's static cookie descriptor served
  with a provider built at startup. Build the server's surfaces and its provider from one
  descriptor value.
- `Protected action '<name>' requires its matching authentication descriptor` thrown by `make`
  or `layer` of `ActionHttp` or `ActionRpc`, or by `ActionMcp.layerHttp`, or a type error there,
  such as `No overload matches this call`, naming `authentication`,
  `"Protected actions take options naming their authentication"` or
  `"Authentication descriptor does not cover every protected action"`: a protected action is
  served and no descriptor is named, or one of another identity than the action declares. Give
  `{ authentication: Login }`.
- `Invalid authentication name: "<name>", not an OpenAPI key` thrown by `make`: the name holds a
  character such as `/` or `:`. Use letters, digits, `_`, `.` and `-`.
- `Authentication takes one native HttpApiSecurity scheme` thrown by `make`, or a type error on
  its `security`: `security` is a record of schemes, or no native scheme. Omit `security` for
  Bearer, or give one scheme.
- `A protected resource is published only for a Bearer scheme` thrown by `layer` or
  `refusalResponse`, or a type error on `protectedResource` at `layer`: the descriptor names a
  scheme other than Bearer. Drop `protectedResource`, or authenticate with a Bearer descriptor.
- Type error at `layer` on `verify`: the verifier fails with an error that is neither a refusal
  nor one its descriptor declares, or succeeds with a value that is not the identity. Declare
  the error in the descriptor's `error`, or map it to a refusal where it is the caller's.
- `Authentication "<name>": error _tag "<tag>" is built in, and declared on every surface` thrown
  by `make`: an `error` entry has the `_tag` of `InvalidInput`, `Unauthenticated` or `Forbidden`.
  Fail with the built-in refusal itself, or give the error a `_tag` of its own.
- A startup service that the Effect building a verifier yields is unsatisfied where the server
  launches: provide it to the provider's layer,
  `Authentication.layer(Login, build).pipe(Layer.provide(Directory.layer))`, or above it.
- `Request<"Requires", Tenant>` still owed although the tenant middleware's layer is provided:
  the middleware's layer is in one `Layer.provide([...])` array with the provider, whose
  members do not provide to one another. Provide it in a later `Layer.provide` of its own
  ([Read request context in a verifier](Authentication-advanced.md#read-request-context-in-a-verifier)).

## Requests

- An action that must be authenticated answers without credentials: its contract states
  `caller: Action.Anyone`. Make it protected; the surfaces then authenticate it, whatever its
  handler reads.
- A request the `Host` or `Origin` check should refuse gets a 401 and a challenge: the check is
  the layer's own `middleware`, which runs inside authentication. Make it global router
  middleware
  ([Run a request policy before authentication](Authentication-advanced.md#run-a-request-policy-before-authentication)).
- An MCP host asks for sign-in when it connects: every tool of the endpoint is protected, or
  the host opens a session with `initialize`, as a client of MCP 2025 does, and a session's
  every request authenticates wherever a protected tool is served. Only a 2026-07-28 request
  lists the tools and calls a public one signed out, on an endpoint that serves public tools
  too ([ActionMcp.md](ActionMcp.md#protect-tools)).
- A verifier's declared error arrives as 422: the error states no `httpApiStatus`. Give it the
  status it means, such as `{ httpApiStatus: 503 }`.
- `ActionMcp.client` fails with an `McpCallError`, not a typed error, when the verifier fails
  with an error its descriptor declares: over MCP that failure is the endpoint's HTTP answer,
  before any tool runs. Pass the endpoint's descriptor as the client's `authentication`.
- A route's `Cache-Control` is replaced by `no-store`: only a route's own answer keeps its
  caching, and this response is a failure that enclosing middleware serialized.

## Discovery and scopes

- OAuth discovery returns 404, or an MCP client does not find the authorization server: the
  request's path and query do not match `resource`'s exactly, or the provider is provided to no
  served layer. Set `resource` to the endpoint's exact public URL, and provide the provider to
  the routes served.
- A request the `Host` or `Origin` policy refuses elsewhere still reads the OAuth discovery
  document: the policy registered after the provider. Provide the policy in the last
  `Layer.provide`
  ([Run a request policy before authentication](Authentication-advanced.md#run-a-request-policy-before-authentication)).
- An MCP client asks a user who only reads to consent to writes on first login: the 401 names no
  scope, so the client requests every one of `scopesSupported`. Give `scopesRequired`.
- An MCP client reports `InsufficientScopeError` instead of re-authorizing: it has no OAuth
  provider configured. Configure one, or grant the scope up front.
- `new Action.Forbidden({ scopes })` throws a schema validation error, or
  `Invalid scope in scopesRequired: "<scope>"`, or `in scopesSupported`, is thrown by `layer` or
  `refusalResponse`, or is a defect when a resource an Effect builds is built: a scope is no
  OAuth scope token (it is empty, or holds a space, `"` or `\`). Give each scope as its own
  element.
- `A protected resource has no fragment: <resource>` thrown by `layer` or `refusalResponse`, or
  a defect when a resource an Effect builds is built: `resource` has a `#fragment`, which no
  request URL carries. Drop the fragment.

## Refusing outside the router

- `Not a refusal, nor an error the authentication declares` thrown by `refusalResponse`: the
  error is neither, or the descriptor declaring it was not given. Pass `authentication`.
