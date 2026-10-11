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

See [notes-service/src/identity/Identity.ts](../examples/notes-service/src/identity/Identity.ts)
and [notes-service/src/Api.ts](../examples/notes-service/src/Api.ts). An MCP endpoint names it
the same way ([notes-service/src/routes.ts](../examples/notes-service/src/routes.ts)), and so
does an RPC binding ([live-rpc/src/Rpc.ts](../examples/live-rpc/src/Rpc.ts)).

- The descriptor is browser-safe, and every client of the binding imports it: keep it in the
  contract file. Keep `layer`, and what its verifier imports, in server-only modules.
- The name is the descriptor's type identity: a provider of another descriptor does not
  satisfy a layer, even one of the same identity. Use one name for one declaration. It holds
  only letters, digits, `_`, `.` and `-`: `notes-service.Login`, not `notes-service/Login`.
- A descriptor names one scheme, and a binding or an endpoint names one descriptor, whose
  identity every protected action it holds declares. There is no fallback between schemes: a
  host accepting two credentials for one identity declares two descriptors and serves them on
  two bindings or endpoints
  ([kitchen-sink/src/identity/Identity.ts](../examples/kitchen-sink/src/identity/Identity.ts)).
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
[notes-service/src/identity/verifier.ts](../examples/notes-service/src/identity/verifier.ts) and
[notes-service/src/routes.ts](../examples/notes-service/src/routes.ts).

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
  ([kitchen-sink/src/identity/authenticate.ts](../examples/kitchen-sink/src/identity/authenticate.ts)).
- Call `Authentication.layer` once per descriptor and provide that one value wherever a
  provider is required.
- A failure that is not the caller's, such as an issuer the verifier cannot reach, is an error
  the descriptor declares, with `{ httpApiStatus: 503 }`: an `Unauthenticated` would have the
  caller sign in again, which cannot help. `ActionHttp.client` and `ActionRpc.client` decode
  it; over MCP it is the endpoint's HTTP answer, not a tool result, and `Testing.mcpClient`
  fails with an `McpCallError`
  ([kitchen-sink/src/identity/Identity.ts](../examples/kitchen-sink/src/identity/Identity.ts),
  [kitchen-sink/test/identity/identity.test.ts](../examples/kitchen-sink/test/identity/identity.test.ts)).
- Over RPC the verifier runs for each message of a protected rpc, not once per connection
  ([live-rpc/src/identity/verifier.ts](../examples/live-rpc/src/identity/verifier.ts)).

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

See [notes-service/src/identity/verifier.ts](../examples/notes-service/src/identity/verifier.ts)
and [kitchen-sink/test/identity/identity.test.ts](../examples/kitchen-sink/test/identity/identity.test.ts).

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
  [Run a request policy before authentication](Authentication-advanced.md#run-a-request-policy-before-authentication).

### Step up for a scope

A step-up refusal is one an OAuth client acts on: `Action.Unauthenticated`, which it signs in
on, or an `Action.Forbidden` naming `scopes`, which it re-authorizes on with those scopes
added. The authorizer, a handler or the verifier may fail with one:
[notes-service/src/identity/authorize.ts](../examples/notes-service/src/identity/authorize.ts).

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
  ([kitchen-sink/src/identity/authenticate.ts](../examples/kitchen-sink/src/identity/authenticate.ts)).
- Map another service's refusals before failing with them
  ([Action.md](Action.md#fail-with-declared-and-built-in-errors)): passed on, a `Forbidden`
  naming that service's scopes sends this server's caller to re-authorize for them.

## Examples

| File                                                                                                   | Shows                                                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [notes-service/src/identity/Identity.ts](../examples/notes-service/src/identity/Identity.ts)           | A Bearer descriptor beside its identity service.                                |
| [notes-service/src/identity/verifier.ts](../examples/notes-service/src/identity/verifier.ts)           | A plain verifier, and discovery read from config.                               |
| [notes-service/src/identity/authorize.ts](../examples/notes-service/src/identity/authorize.ts)         | A `Forbidden` naming the scope a call lacks.                                    |
| [notes-service/src/routes.ts](../examples/notes-service/src/routes.ts)                                 | One provider for HTTP routes and an MCP endpoint.                               |
| [notes-service/test/routes.test.ts](../examples/notes-service/test/routes.test.ts)                     | Refusals over HTTP, and tools called as a signed-in caller, in memory.          |
| [live-rpc/src/identity/verifier.ts](../examples/live-rpc/src/identity/verifier.ts)                     | A provider without discovery, verifying each RPC message.                       |
| [kitchen-sink/src/identity/Identity.ts](../examples/kitchen-sink/src/identity/Identity.ts)             | Two descriptors for one identity, a cookie beside Bearer; a declared 503.       |
| [kitchen-sink/src/identity/authenticate.ts](../examples/kitchen-sink/src/identity/authenticate.ts)     | Verifiers built from startup services, one reading the tenant per request.      |
| [kitchen-sink/src/workspaces/tenant.ts](../examples/kitchen-sink/src/workspaces/tenant.ts)             | Router middleware providing what a verifier reads.                              |
| [kitchen-sink/src/routes.ts](../examples/kitchen-sink/src/routes.ts)                                   | The provide order: providers, tenant, CORS, request policy.                     |
| [kitchen-sink/src/request-policy.ts](../examples/kitchen-sink/src/request-policy.ts)                   | A Host and Origin policy as global middleware, and CORS.                        |
| [kitchen-sink/test/request-policy.test.ts](../examples/kitchen-sink/test/request-policy.test.ts)       | The policy refusing before authentication and before discovery.                 |
| [kitchen-sink/src/attachments/download.ts](../examples/kitchen-sink/src/attachments/download.ts)       | `protect` on a route of the host's own, stating its caching.                    |
| [kitchen-sink/src/admin/Admin.ts](../examples/kitchen-sink/src/admin/Admin.ts)                         | An API key in a header, and a trusted identity no verifier returns.             |
| [kitchen-sink/src/admin/authenticate.ts](../examples/kitchen-sink/src/admin/authenticate.ts)           | A provider for a second identity, on a second listener.                         |
| [kitchen-sink/test/identity/identity.test.ts](../examples/kitchen-sink/test/identity/identity.test.ts) | A 403 challenge, discovery, an MCP endpoint's 401, a verifier's declared error. |
| [kitchen-sink/test/identity/session.test.ts](../examples/kitchen-sink/test/identity/session.test.ts)   | A session cookie authenticating each RPC message.                               |
