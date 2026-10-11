# Authentication failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [Authentication.md](Authentication.md).

## Types and startup

- `Provider<CurrentUser, "notes-service.Login">` among a layer's requirements,
  `Type 'Provider<...>' is not assignable to type 'never'` at `Layer.launch` or
  `NodeRuntime.runMain`, or `Expected 2 arguments, but got 1` at a web handler's
  `handler(request)`: a layer serves protected actions and no provider of its descriptor is
  provided to it. Provide it, `Layer.provide(authenticate)`; nothing else satisfies it, the
  identity itself included ([Verify credentials](Authentication.md#verify-credentials)). Where the routes require
  no provider, `Expected 2 arguments` means their platform services are not provided
  ([Testing.md](Testing-failures.md)).
- `Provider<...>` still owed although a `layer` is provided: it is the provider of another
  descriptor, of the same identity or not. Provide the one the binding or endpoint names.
- `Authentication "<name>": the binding's descriptor is not its provider's`, a defect when
  `ActionHttp.layer` or `ActionRpc.layer` builds: the binding names a descriptor built apart from
  the one `layer` was given, such as the same options passed to `make` twice, or a browser's
  static cookie descriptor served with a provider built at startup. Give the server's binding
  the descriptor its provider was built from.
- `No overload matches this call` at `ActionHttp.make` or `ActionRpc.make`, its last overload
  naming `"Protected actions take options naming their authentication"`, or a type error naming
  `authentication` there or at `ActionMcp.layerHttp`: a protected action is served and no
  descriptor named. Give `{ authentication: Login }`.
  `"Authentication descriptor does not cover every protected action"` instead: the descriptor's
  identity is not the one the protected actions declare.
- `Protected action '<name>' requires its matching authentication descriptor` thrown by
  `ActionHttp.make`, `ActionHttp.layer`, `ActionRpc.make`, `ActionRpc.layer` or
  `ActionMcp.layerHttp`: plain JavaScript gave no descriptor, or one of another identity.
- `Invalid authentication name: "<name>", not an OpenAPI key` thrown by `make`: the name holds a
  character such as `/` or `:`. Use letters, digits, `_`, `.` and `-`.
- A type error on `security` at `make`, or `Authentication takes one native HttpApiSecurity scheme`
  thrown by it: `security` is a record of schemes, or no native scheme. Omit it for Bearer, or
  give one scheme.
- A type error on `protectedResource` at `layer`, or
  `A protected resource is published only for a Bearer scheme` thrown by `layer` or
  `refusalResponse`: the descriptor names another scheme. Drop the resource, or authenticate
  with a Bearer descriptor.
- Type error at `layer` on `verify`: the verifier fails with an error that is neither a refusal
  nor one its descriptor declares, or succeeds with a value that is not the identity. Declare
  the error in the descriptor's `error`, or map it to a refusal where it is the caller's.
- `Authentication "<name>": error _tag "<tag>" is built in, and declared on every surface` thrown
  by `make`: an `error` entry has the `_tag` of `InvalidInput`, `Unauthenticated` or `Forbidden`.
  Fail with the built-in refusal itself, or give the error a `_tag` of its own.
- `Missing verify: pass a verify function, or an Effect building one`, a defect when the
  provider's layer builds: plain JavaScript gave `layer` neither.
- A startup service the verifier's builder yields is unsatisfied where the server launches:
  provide it to the provider's layer,
  `Authentication.layer(Login, build).pipe(Layer.provide(Directory.layer))`, or above it.
- `Request<"Requires", Tenant>` still owed although the tenant middleware's layer is provided: it
  is in one array with the provider. Provide it in a later `Layer.provide` of its own
  ([Read request context in a verifier](Authentication-advanced.md#read-request-context-in-a-verifier)).

## Requests

- An action that must be authenticated answers without credentials: its contract states
  `caller: Action.Anyone`. Make it protected; the surfaces then authenticate it, whatever its
  handler reads.
- A request the `Host` or `Origin` check should refuse gets a 401 and a challenge: the check is
  the layer's own `middleware`, which runs inside authentication. Make it global router
  middleware ([Run a request policy before authentication](Authentication-advanced.md#run-a-request-policy-before-authentication)).
- A public tool's call answers 401 on an MCP endpoint serving protected tools too: it presented
  a credential that does not verify, such as an expired token, and the endpoint verifies a
  credential it is given. Send a valid one, or none.
- An MCP host asks for sign-in when it connects: every tool of the endpoint is protected, so
  every request authenticates. An endpoint serving public tools too lists its tools and runs the
  public ones signed out ([ActionMcp.md](ActionMcp.md#protect-tools)).
- A verifier's declared error arrives as 422, which a client reads as its request being wrong:
  the error states no `httpApiStatus`. Give it the status it means, such as
  `{ httpApiStatus: 503 }`.
- `Testing.mcpClient` fails with an `McpCallError`, not a typed error, when the verifier fails
  with a declared one: over MCP it is the endpoint's HTTP answer, before any tool runs. The
  `McpCallError` names its status and body.
- A route's `Cache-Control` is replaced by `no-store`: enclosing middleware serialized the
  response of a failure. Only a route's own answer keeps its caching.

## Discovery and scopes

- Discovery returns 404: the request's path and query do not match `resource`'s exactly, or the
  provider is provided to no served layer.
- An MCP client does not find the authorization server: discovery is not at the well-known URL
  for the endpoint's path. Set `resource` to the endpoint's exact public URL.
- A request the policy refuses elsewhere still reads the discovery document: the policy
  registered after the provider. Provide it in the last `Layer.provide`.
- An MCP client asks a user who only reads to consent to writes on first login: the 401 names no
  scope, so it requests every one of `scopesSupported`. Give `scopesRequired`.
- An MCP client reports `InsufficientScopeError` instead of re-authorizing: it has no OAuth
  provider configured, so it cannot step up. Configure one, or grant the scope up front.
- `new Action.Forbidden({ scopes })` throws a schema validation error: a scope is no OAuth scope
  token (it is empty, or holds a space, `"` or `\`). Give each scope as its own element.
- `Invalid scope in scopesRequired: "<scope>"`, or `in scopesSupported`, thrown by `layer` or
  `refusalResponse`, or for a built resource a defect when its layer builds: the same, in the
  resource.
- `A protected resource has no fragment: <resource>` thrown by `layer` or `refusalResponse`, or
  for a built resource a defect when its layer builds: `resource` has a `#fragment`, which no
  request URL carries. Drop it.

## Refusing outside the router

- `Not a refusal, nor an error the authentication declares` thrown by `refusalResponse`: the
  error is neither, or the descriptor declaring it was not given. Pass `authentication`.
