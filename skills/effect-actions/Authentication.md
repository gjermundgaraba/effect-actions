# Authentication

How a remote caller proves the identity a protected action declares. `Authentication.make`
declares it, as a browser-safe descriptor; `Authentication.layer` is that descriptor's provider,
running the verifier you write. Verifying a token, login and consent stay in the application.

Read this page alone, in one tool call; if its output says it was truncated, read it again alone.
When something fails, search [Authentication-failures.md](Authentication-failures.md). Reading
order: [SKILL.md](SKILL.md).

## API

Import `@gjermundgaraba/effect-actions/Authentication`.

| API                                           | Purpose                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `make(name, identity, { security, error }?)`  | A browser-safe authentication descriptor: how a caller proves `identity`, by one native scheme.       |
| `layer(descriptor, verify, options?)`         | Its provider: the server-only verifier, or an Effect building it once per layer graph, and discovery. |
| `Any`                                         | Any descriptor, erased: what a binding's and an MCP endpoint's `authentication` take.                 |
| `Descriptor`, `Provider`                      | What `make` and `layer` return, to name in a package that emits declarations.                         |
| `Verify`, `Options`, `LayerOptions`           | The verifier's type, and `make`'s and `layer`'s options.                                              |
| `ProtectedResource`                           | An OAuth protected resource.                                                                          |
| `protect`, `bearerTokenOf`, `refusalResponse` | In [Authentication-advanced.md](Authentication-advanced.md#api), with their types and options.        |

| Option              | Of      | Meaning                                                                                 |
| ------------------- | ------- | --------------------------------------------------------------------------------------- |
| `security`          | `make`  | One native `HttpApiSecurity` scheme; `HttpApiSecurity.bearer` when omitted.             |
| `error`             | `make`  | What the verifier may fail with besides a refusal: one schema, or a list.               |
| `protectedResource` | `layer` | Bearer only: an OAuth protected resource to publish, or an Effect building one or none. |

| Protected resource field | Meaning                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `resource`               | Required exact OAuth resource identifier; its path and query select the discovery URL. |
| `authorizationServers`   | Required, nonempty: where clients get tokens.                                          |
| `scopesSupported`        | Optional OAuth scope tokens: every scope the resource accepts.                         |
| `scopesRequired`         | Optional, nonempty OAuth scope tokens: every 401 names them.                           |
| `resourceName`           | Optional human-readable name.                                                          |

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

See [notes-service/src/identity/Identity.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/identity/Identity.ts)
and [notes-service/src/Api.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/Api.ts). An MCP endpoint names it
the same way ([notes-service/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/routes.ts)), and so
does an RPC binding ([live-rpc/src/Rpc.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/Rpc.ts)).

- Every client of the binding imports the descriptor: keep it in the contract file. Keep
  `layer`, and what its verifier imports, in server-only modules.
- The name is the descriptor's type identity: use one name for one declaration. It holds only
  letters, digits, `_`, `.` and `-`.
- A descriptor names one scheme, and a binding or an endpoint names one descriptor. There is no
  fallback between schemes: a host accepting two credentials for one identity declares two
  descriptors and serves them on two bindings or endpoints
  ([kitchen-sink/src/identity/Identity.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/Identity.ts)).
- Build a server's surfaces and its provider from one descriptor value. `ActionHttp.layer`,
  `ActionRpc.layer`, `ActionMcp.layerHttp` and `Authentication.protect` refuse, when they build,
  a descriptor that is another object than the one the provider was given, equal name and
  options or not.
- Protecting an action that tests already call breaks them. An `Action.client` call then owes
  `Type 'CurrentUser' is missing … from type 'Scope'`: provide the caller around each call
  ([Testing-failures.md](Testing-failures.md)). A test that builds `ActionMcp.layerHttp` itself
  gets `Property 'authentication' is missing`: serve `routes` with `Testing.layer`
  ([ActionMcp-failures.md](ActionMcp-failures.md)). A call over HTTP without a credential gets
  `Unauthenticated` at run time.
- A local surface has no remote caller and takes no descriptor: the host provides the identity
  itself, for a CLI ([ActionCli.md](ActionCli.md#name-the-caller)), a Toolkit
  ([ActionToolkit.md](ActionToolkit.md#name-the-caller)) and an MCP server over stdio
  ([ActionMcp.md](ActionMcp.md#serve-tools-over-stdio)).

## Verify credentials

Write the verifier in a server-only module, give it to `Authentication.layer`, and provide that
layer to every layer serving a protected action: `routes.pipe(Layer.provide(authenticate))`. The
verifier takes the credential and succeeds with the identity, or fails with
`Action.Unauthenticated`, `Action.Forbidden` or an error the descriptor declares. See
[notes-service/src/identity/verifier.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/identity/verifier.ts) and
[notes-service/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/routes.ts).

- **The library reads no token.** Everything that makes a credential valid is the verifier's to
  check, with your authorization server's library: its signature, its expiry, and its audience.
  A token issued for another resource fails with `Unauthenticated`. Only a missing or empty
  credential is refused before the verifier runs.
- **Never provide the identity service, or a tenant, at startup**, in a layer or around
  `HttpRouter.serve` or the program. It does not satisfy the provider a protected route
  requires, and a public handler or a route of your own reading it would serve every caller as
  that identity. A test sends a credential instead
  ([Testing.md](Testing.md#test-as-a-signed-in-caller)).
- A verifier that needs startup services, such as a user directory, is passed as an Effect that
  yields them and returns the verifier: a builder ([Action.md](Action.md#implement-actions)),
  run once per layer graph
  ([kitchen-sink/src/identity/authenticate.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/authenticate.ts)).
- Call `Authentication.layer` once per descriptor and provide that one value wherever a
  provider is required.
- A failure that is not the caller's, such as an issuer the verifier cannot reach, is an error
  the descriptor declares, with `{ httpApiStatus: 503 }`: an `Unauthenticated` would have the
  caller sign in again
  ([kitchen-sink/src/identity/Identity.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/Identity.ts),
  [kitchen-sink/test/identity/identity.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/identity/identity.test.ts)).
- Over RPC the verifier runs for each message of a protected rpc, not once per connection
  ([live-rpc/src/identity/verifier.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/identity/verifier.ts),
  [kitchen-sink/test/identity/session.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/identity/session.test.ts)).

What each surface answers a missing or refused credential with:
[guarantees.md](guarantees.md#wire-behavior), as
[notes-service/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/test/routes.test.ts) asserts.

## Publish OAuth discovery

Give a Bearer descriptor's `layer` a `protectedResource`. The provider then publishes OAuth
protected-resource discovery (RFC 9728) and names it in every challenge, so an MCP client that
gets a 401 finds the authorization server. Without it the challenge names nowhere to sign in,
so an MCP endpoint whose users sign in through OAuth publishes it. See
[notes-service/src/identity/verifier.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/identity/verifier.ts)
and [kitchen-sink/test/identity/identity.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/identity/identity.test.ts).

- `resource` is the exact public URL of the endpoint clients connect to: discovery is served at
  `/.well-known/oauth-protected-resource` followed by its path. Only the deployment knows that
  URL, so give the resource as an Effect reading configuration; succeeding with `undefined`
  publishes nothing.
- That `resource` and `authorizationServers` are HTTPS, or loopback HTTP in development, is the
  deployment's to ensure: the provider does not check it.
- Give `scopesRequired` whenever some actions need scopes others do not. An MCP client requests
  the scopes a 401 names, or every one of `scopesSupported` when it names none.
- Discovery is public. It answers before routing, to any origin, so no authentication and no
  route middleware covers it: to restrict who reads it, see
  [Run a request policy before authentication](Authentication-advanced.md#run-a-request-policy-before-authentication).

### Step up for a scope

A step-up refusal is one an OAuth client acts on: `Action.Unauthenticated`, which it signs in
on, or an `Action.Forbidden` naming `scopes`, which it re-authorizes on with those scopes
added. The authorizer, a handler or the verifier may fail with one:
[notes-service/src/identity/authorize.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/identity/authorize.ts).

- Step-up is a Bearer descriptor's, for protected actions and routes under `protect`: the
  refusal answers the request with 401 or 403 and its challenge, over MCP in place of the tool
  result.
- On a public action or under another scheme, an authorizer's or a handler's refusal is
  answered like a declared error, and RPC never steps up: a refusal is the call's typed failure
  ([guarantees.md](guarantees.md#wire-behavior)).
- Name scopes only when re-authorizing can grant them: a server with fixed tokens, such as API
  keys, leaves `scopes` out
  ([kitchen-sink/src/identity/authenticate.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/authenticate.ts)).
  A `Forbidden` without them prompts no login; what it answers on each surface is in
  [guarantees.md](guarantees.md#wire-behavior).
- Map another service's refusals before failing with them
  ([Action.md](Action.md#fail-with-declared-and-built-in-errors)): passed on, a `Forbidden`
  naming that service's scopes sends this server's caller to re-authorize for them.
