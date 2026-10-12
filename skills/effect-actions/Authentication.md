# Authentication

How a remote caller proves the identity a protected action declares. `Authentication.make`
declares it: a browser-safe authentication descriptor, which a binding and an MCP endpoint
serving protected actions name. `Authentication.layer` is that descriptor's provider: the
server-only verifier, which every HTTP, MCP or RPC layer serving a protected action requires.
The library runs the verifier you give it and answers its refusals; verifying a token, login and
consent stay in the application.

## API

Import `@gjermundgaraba/effect-actions/Authentication`.

| API                                           | Purpose                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `make(name, identity, { security, error }?)`  | A browser-safe authentication descriptor: how a caller proves `identity`, by one native scheme.       |
| `layer(descriptor, verify, options?)`         | Its provider: the server-only verifier, or an Effect building it once per layer graph, and discovery. |
| `protect(descriptor)`                         | Router middleware authenticating a route of the host's own as the descriptor's actions are.           |
| `bearerTokenOf(authorization)`                | The bearer token of an `Authorization` header value, an `Option`, for an unrouted caller.             |
| `refusalResponse(error, options?)`            | The response authentication answers a refusal with, for a caller the router never routes.             |
| `Any`                                         | Any descriptor, erased: what a binding's and an MCP endpoint's `authentication` take.                 |
| `Descriptor`, `Provider`, `Protection`        | What `make`, `layer` and `protect` return, to name in a package that emits declarations.              |
| `Verify`, `Options`, `LayerOptions`           | The verifier's type, and `make`'s and `layer`'s options.                                              |
| `ProtectedResource`, `RefusalResponseOptions` | An OAuth protected resource, and what `refusalResponse` takes.                                        |

| Option              | Of                | Meaning                                                                                  |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `security`          | `make`            | One native `HttpApiSecurity` scheme; `HttpApiSecurity.bearer` when omitted.              |
| `error`             | `make`            | What the verifier may fail with besides a refusal: one schema, or a list.                |
| `protectedResource` | `layer`           | Bearer only: an OAuth protected resource to publish, or an Effect building one or none.  |
| `authentication`    | `refusalResponse` | The descriptor refusing: needed for an error it declares, or a scheme other than Bearer. |
| `protectedResource` | `refusalResponse` | The resource `layer` was given, as a value.                                              |
| `authorization`     | `refusalResponse` | The request's `Authorization` header: decides whether a 401 says `invalid_token`.        |

| Protected resource field | Meaning                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `resource`               | Required exact OAuth resource identifier; its path and query select the discovery URL.        |
| `authorizationServers`   | Required, nonempty: where clients get tokens.                                                 |
| `scopesSupported`        | Optional OAuth scope tokens: every scope the resource accepts, published in discovery.        |
| `scopesRequired`         | Optional, nonempty OAuth scope tokens: every 401 names them, and a first login requests them. |
| `resourceName`           | Optional human-readable name.                                                                 |

## Declare how callers sign in

A protected action declares its identity service, `caller: CurrentUser`
([Action.md](Action.md#say-who-may-call-an-action)). Declare the descriptor beside that
service, and name it in every binding and MCP endpoint that serves a protected action:

```ts
// identity/Identity.ts
export const Login = Authentication.make("notes-service.Login", CurrentUser);

// Api.ts
export const Http = ActionHttp.make([GetStatus, ...Notes, WhoAmI], {
  prefix: "/api",
  authentication: Login,
});
```

See [notes-service/src/identity/Identity.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/identity/Identity.ts)
and [notes-service/src/Api.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/Api.ts). An MCP endpoint names it
the same way ([notes-service/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/routes.ts)), and so
does an RPC binding ([live-rpc/src/Rpc.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/live-rpc/src/Rpc.ts)).

- The descriptor is browser-safe, and every client of the binding imports it: keep it in the
  contract file. Keep `layer`, and what its verifier imports, in server-only modules.
- The name is the descriptor's type identity: a provider of another descriptor does not
  satisfy a layer, even one of the same identity. Use one name for one declaration. It holds
  only letters, digits, `_`, `.` and `-`: `notes-service.Login`, not `notes-service/Login`.
- A descriptor names one scheme, and a binding or an endpoint names one descriptor, whose
  identity every protected action it holds declares. There is no fallback between schemes: a
  host accepting two credentials for one identity declares two descriptors and serves them on
  two bindings or endpoints
  ([kitchen-sink/src/identity/Identity.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/Identity.ts)).
- Build a server's binding and its provider from one descriptor value. `ActionHttp.layer` and
  `ActionRpc.layer` refuse, when they build, a binding whose descriptor is another object than
  the one its provider was given, equal name and options or not.
- A local surface has no remote caller and takes no descriptor: the host provides the identity
  itself ([ActionCli.md](ActionCli.md#name-the-caller), [ActionToolkit.md](ActionToolkit.md#name-the-caller)).

## Verify credentials

Write the verifier in a server-only module, give it to `Authentication.layer`, and provide that
layer to every layer serving a protected action: `routes.pipe(Layer.provide(authenticate))`. The
verifier takes the credential and succeeds with the identity, or fails with
`Action.Unauthenticated`, `Action.Forbidden` or an error the descriptor declares. See
[notes-service/src/identity/verifier.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/identity/verifier.ts) and
[notes-service/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/routes.ts).

- **The library reads no token.** Everything that makes a credential valid is the verifier's to
  check, with your authorization server's library: its signature, its expiry, and its audience.
  A token issued for another resource fails with `Unauthenticated`, as MCP authorization
  requires (RFC 8707). Only a missing or empty credential is refused before the verifier runs.
- **Never provide the identity service, or a tenant, at startup**, in a layer or around
  `HttpRouter.serve` or the program. It does not satisfy the provider a protected route
  requires, and a public handler or a route of your own reading it would serve every caller as
  that identity. A test sends a credential instead
  ([Testing.md](Testing.md#test-as-a-signed-in-caller)).
- A verifier that needs startup services, such as a user directory, is passed as an Effect that
  yields them and returns the verifier. It is a builder, as `Action.implement` takes one
  ([Action.md](Action.md#implement-actions)): it runs once per layer graph, and what it yields
  is a startup requirement of the provider's layer
  ([kitchen-sink/src/identity/authenticate.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/authenticate.ts)).
- Call `Authentication.layer` once per descriptor and provide that one value wherever a
  provider is required.
- A failure that is not the caller's, such as an issuer the verifier cannot reach, is an error
  the descriptor declares, with `{ httpApiStatus: 503 }`: an `Unauthenticated` would have the
  caller sign in again, which cannot help. `ActionHttp.client` and `ActionRpc.client` decode
  it; over MCP it is the endpoint's HTTP answer, not a tool result, and `Testing.mcpClient`
  fails with an `McpCallError`
  ([kitchen-sink/src/identity/Identity.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/Identity.ts),
  [kitchen-sink/test/identity/identity.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/identity.test.ts)).
- Over RPC the verifier runs for each message of a protected rpc, not once per connection
  ([live-rpc/src/identity/verifier.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/live-rpc/src/identity/verifier.ts)).

What each surface answers a missing or refused credential with:
[guarantees.md](guarantees.md#wire-behavior).

## Publish OAuth discovery

Give a Bearer descriptor's `layer` a `protectedResource`. The provider then publishes OAuth
protected-resource discovery (RFC 9728) and names it in every challenge, so an MCP client that
gets a 401 finds the authorization server.

```ts
export const authenticate = Authentication.layer(Login, verify, {
  protectedResource: Effect.map(
    Config.String("PUBLIC_URL").pipe(Config.withDefault("http://localhost:3000")),
    (url) =>
      ({
        resource: `${url}/mcp`,
        authorizationServers: ["https://auth.example.com"],
        scopesSupported: [scopes.read, scopes.write],
        scopesRequired: [scopes.read],
      }) satisfies Authentication.ProtectedResource,
  ),
});
```

See [notes-service/src/identity/verifier.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/identity/verifier.ts)
and [kitchen-sink/test/identity/identity.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/identity.test.ts).

- `resource` is the exact public URL of the endpoint clients connect to: discovery is served at
  `/.well-known/oauth-protected-resource` followed by its path. Only the deployment knows that
  URL, so give the resource as an Effect reading configuration. It runs when the provider is
  built; succeeding with `undefined` publishes nothing.
- The provider checks only that `resource` parses and has no fragment, and that each scope is a
  scope token. That `resource` and `authorizationServers` are HTTPS, or loopback HTTP in
  development, is the deployment's to ensure.
- Give `scopesRequired` whenever some actions need scopes others do not. An MCP client requests
  the scopes a 401 names, or every one of `scopesSupported` when it names none.
- Publishing requires the `HttpRouter`. Without a resource the provider requires no router, so
  an RPC server over a socket or stdio uses it too.
- Discovery is public. It answers before routing, to any origin, so no authentication and no
  route middleware covers it: to restrict who reads it, see
  [Run a request policy before authentication](#run-a-request-policy-before-authentication).

### Step up for a scope

A step-up refusal is one an OAuth client acts on: `Action.Unauthenticated`, which it signs in
on, or an `Action.Forbidden` naming `scopes`, which it re-authorizes on with those scopes
added. The authorizer, a handler or the verifier may fail with one:
[notes-service/src/identity/authorize.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/identity/authorize.ts).

- Step-up is a Bearer descriptor's, for protected actions. On a protected HTTP route, a route
  under `protect`, and a protected tool's call on an MCP endpoint naming the descriptor, the
  refusal answers the request with 401 or 403 and its challenge; over MCP that replaces the
  tool result.
- Anywhere else, on a public action or under another scheme, no OAuth client can act on it: an
  authorizer's or a handler's refusal is answered like a declared error, its JSON with its
  status over HTTP and a tool result over MCP. Over HTTP and MCP a verifier's refusal always
  answers the request itself. RPC never steps up: a refusal is the call's typed failure.
- Name scopes only when re-authorizing can grant them. Otherwise fail with a `Forbidden` naming
  none, a plain 403, rather than a login prompt that cannot help
  ([kitchen-sink/src/identity/authenticate.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/authenticate.ts)).
- Map another service's refusals before failing with them
  ([Action.md](Action.md#fail-with-declared-and-built-in-errors)): passed on, a `Forbidden`
  naming that service's scopes sends this server's caller to re-authorize for them.

## Read request context in a verifier

A verifier may read per-request services: the request, which the router provides, or one of
your own, such as the tenant a request addresses, which native router middleware provides.
Provide that middleware after the provider, in a `Layer.provide` of its own:

```ts
routes.pipe(Layer.provide(authenticate), Layer.provide(resolveTenant.layer));
```

See [kitchen-sink/src/workspaces/tenant.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/workspaces/tenant.ts),
[kitchen-sink/src/identity/authenticate.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/authenticate.ts)
and `publicRoutes` in [kitchen-sink/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/routes.ts).

- Each `Layer.provide` gives what the layers before it still owe. In one array,
  `Layer.provide([authenticate, resolveTenant.layer])`, the members provide to the routes and
  not to one another, and the tenant stays owed.
- A startup service is yielded by the Effect building the verifier, never by the verifier per
  request.
- Router middleware provided around the routes runs before their authentication. Middleware
  that reads the identity runs inside it: give it to the layer as its own `middleware`
  ([ActionHttp.md](ActionHttp.md#serve-the-routes), [ActionRpc.md](ActionRpc.md#serve-the-rpcs)).

## Use a scheme other than Bearer

Name the scheme in `security`: an API key in a cookie, a header or the query, or
`HttpApiSecurity.basic`. The verifier receives what that scheme decodes.

```ts
export const Session = Authentication.make("tracker.Session", CurrentMember, {
  security: HttpApiSecurity.apiKey({ in: "cookie", key: "tracker_session" }),
});
```

See [kitchen-sink/src/identity/Identity.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/Identity.ts)
and [kitchen-sink/src/identity/authenticate.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/authenticate.ts)
for a session cookie beside Bearer, and [kitchen-sink/src/admin/Admin.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/admin/Admin.ts)
and [kitchen-sink/src/admin/authenticate.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/admin/authenticate.ts)
for an API key in a header, for another identity on another listener.

- OAuth is Bearer's. Another scheme takes no `protectedResource` and nothing steps up under it:
  the scopes a `Forbidden` names there are sent in its JSON and challenge nothing.
- A browser attaches a cookie to any page's request, so refuse a foreign `Origin` before
  authentication reads the cookie
  ([Run a request policy before authentication](#run-a-request-policy-before-authentication)).
  CORS guards the JSON routes alone, which a foreign page cannot call without a preflight
  ([ActionHttp.md](ActionHttp.md#call-the-api-from-a-browser)); a WebSocket upgrade is never
  preflighted, so for rpcs over a socket under a cookie that policy is the only check
  ([ActionRpc.md](ActionRpc.md#send-request-context-with-a-call)).
- A scheme the deployment decides, such as a cookie name a framework prefixes over HTTPS, is
  still one declaration. The server builds its descriptor and its binding at startup, under the
  same name and identity; a browser's binding keeps a static one, since a client never reads
  the scheme.
- Basic's credential reaches the verifier when its username or its password is non-empty, so a
  verifier may receive an empty username.

## Protect a route of your own

A descriptor covers action routes alone. A route of the host's own beside them, such as a
download, a page frame or a WebSocket upgrade, takes `Authentication.protect(descriptor)`,
native router middleware:

```ts
HttpRouter.add("GET", "/attachments/:id", handler).pipe(
  Layer.provide(Authentication.protect(Session).layer),
);
```

It requires the descriptor's provider, provides the identity to the route, and answers a refusal
the route fails with as an action's is answered. See
[kitchen-sink/src/attachments/download.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/attachments/download.ts)
and [kitchen-sink/test/attachments/attachments.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/attachments/attachments.test.ts).

- No authorizer runs for such a route: it states its own authorization.
- Every response to a request authentication covers is `Cache-Control: no-store` unless the
  route states its own caching. A route that does says `private` unless its answer is the same
  for every caller: a cache in front of the server may store it and serve it to anyone.
- The route of an RPC protocol needs no `protect`: `ActionRpc.layer` authenticates each
  message itself.

## Run a request policy before authentication

A check that must refuse a request before its credential is read, such as a `Host` or `Origin`
allowlist, is not the layer's own `middleware`, which runs inside authentication. Make it
global router middleware, `HttpRouter.middleware(check, { global: true })`, which runs before
routing, and provide it last:

```ts
export const publicRoutes = Layer.mergeAll(api, mcp, socket, download, documentation, health).pipe(
  Layer.provide([authenticateBearer, authenticateSession, quota]),
  Layer.provide(resolveTenant.layer),
  Layer.provide(cors),
  Layer.provide(requestPolicy),
);
```

See [kitchen-sink/src/request-policy.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/request-policy.ts),
[kitchen-sink/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/routes.ts) and
[kitchen-sink/test/request-policy.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/request-policy.test.ts).

- **The order decides whether the policy covers discovery.** A provider publishing a protected
  resource registers its discovery as global middleware when it is built, and global middleware
  runs in the order it registers. The layer provided last is built first, so the policy
  registers before the provider. Merged beside the routes, with the provider provided around
  the merge, it registers after it, and a foreign `Host` reads the discovery document.
- Global middleware covers every request of the router: discovery, the host's own routes and
  requests no route matches.

## Refuse outside the router

A caller the router never routes, such as a Node `upgrade` handler admitting a socket, holds a
header and no request. Read the token with `bearerTokenOf`, verify it with the verifier the
routes use, and answer a refusal with `refusalResponse`, the response authentication answers
that refusal with on a route. No example has such a caller.

```ts
const admit = (authorization: string | undefined): Effect.Effect<User, Response> =>
  Effect.fromOption(
    Authentication.bearerTokenOf(authorization),
    () => new Action.Unauthenticated(),
  ).pipe(
    Effect.flatMap(verify),
    Effect.mapError((error) =>
      HttpServerResponse.toWeb(
        Authentication.refusalResponse(error, { protectedResource, authorization }),
      ),
    ),
  );
```

- `protectedResource` is the resource `layer` was given, as a value, not the Effect building
  it: export the verifier the routes use, and where `layer` builds the resource from
  configuration, build the handler's from the same configuration. Left out, the challenges name
  no metadata URL and no `scopesRequired`.
- Give `authorization`, or a 401 to a presented token does not say `invalid_token`.
- Give `authentication` when the descriptor declares an error the verifier may fail with, or
  names a scheme other than Bearer: the answer is then the one its routes give.

## Examples

| File                                                                                                   | Shows                                                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [notes-service/src/identity/Identity.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/identity/Identity.ts)           | A Bearer descriptor beside its identity service.                                |
| [notes-service/src/identity/verifier.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/identity/verifier.ts)           | A plain verifier, and discovery read from config.                               |
| [notes-service/src/identity/authorize.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/identity/authorize.ts)         | A `Forbidden` naming the scope a call lacks.                                    |
| [notes-service/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/routes.ts)                                 | One provider for HTTP routes and an MCP endpoint.                               |
| [notes-service/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/test/routes.test.ts)                     | Refusals over HTTP, and tools called as a signed-in caller, in memory.          |
| [live-rpc/src/identity/verifier.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/live-rpc/src/identity/verifier.ts)                     | A provider without discovery, verifying each RPC message.                       |
| [kitchen-sink/src/identity/Identity.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/Identity.ts)             | Two descriptors for one identity, a cookie beside Bearer; a declared 503.       |
| [kitchen-sink/src/identity/authenticate.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/authenticate.ts)     | Verifiers built from startup services, one reading the tenant per request.      |
| [kitchen-sink/src/workspaces/tenant.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/workspaces/tenant.ts)             | Router middleware providing what a verifier reads.                              |
| [kitchen-sink/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/routes.ts)                                   | The provide order: providers, tenant, CORS, request policy.                     |
| [kitchen-sink/src/request-policy.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/request-policy.ts)                   | A Host and Origin policy as global middleware, and CORS.                        |
| [kitchen-sink/test/request-policy.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/request-policy.test.ts)       | The policy refusing before authentication and before discovery.                 |
| [kitchen-sink/src/attachments/download.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/attachments/download.ts)       | `protect` on a route of the host's own, stating its caching.                    |
| [kitchen-sink/src/admin/Admin.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/admin/Admin.ts)                         | An API key in a header, and a trusted identity no verifier returns.             |
| [kitchen-sink/src/admin/authenticate.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/admin/authenticate.ts)           | A provider for a second identity, on a second listener.                         |
| [kitchen-sink/test/identity/identity.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/identity.test.ts) | A 403 challenge, discovery, an MCP endpoint's 401, a verifier's declared error. |
| [kitchen-sink/test/identity/session.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/session.test.ts)   | A session cookie authenticating each RPC message.                               |

## Failure modes

### Types and startup

- `Provider<CurrentUser, "notes-service.Login">` among a layer's requirements,
  `Type 'Provider<...>' is not assignable to type 'never'` at `Layer.launch` or
  `NodeRuntime.runMain`, or `Expected 2 arguments, but got 1` at a web handler's
  `handler(request)`: a layer serves protected actions and no provider of its descriptor is
  provided to it. Provide it, `Layer.provide(authenticate)`; nothing else satisfies it, the
  identity itself included ([Verify credentials](#verify-credentials)). Where the routes require
  no provider, `Expected 2 arguments` means their platform services are not provided
  ([Testing.md](Testing.md#failure-modes)).
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
  ([Read request context in a verifier](#read-request-context-in-a-verifier)).

### Requests

- An action that must be authenticated answers without credentials: its contract states
  `caller: Action.Anyone`. Make it protected; the surfaces then authenticate it, whatever its
  handler reads.
- A request the `Host` or `Origin` check should refuse gets a 401 and a challenge: the check is
  the layer's own `middleware`, which runs inside authentication. Make it global router
  middleware ([Run a request policy before authentication](#run-a-request-policy-before-authentication)).
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

### Discovery and scopes

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

### Refusing outside the router

- `Not a refusal, nor an error the authentication declares` thrown by `refusalResponse`: the
  error is neither, or the descriptor declaring it was not given. Pass `authentication`.
