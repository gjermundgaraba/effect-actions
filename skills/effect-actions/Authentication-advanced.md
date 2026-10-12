# Authentication beyond a bearer token

A verifier reading the request, an API key or a cookie, a route of your own, a policy before
authentication, and a refusal outside the router.

Read [Authentication.md](Authentication.md) first, and this page alone, in one tool call. When
something fails, search [Authentication-failures.md](Authentication-failures.md). Reading order:
[README.md](README.md).

## API

Import `@gjermundgaraba/effect-actions/Authentication`. `make` and `layer`:
[Authentication.md](Authentication.md#api).

| API                                    | Purpose                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `protect(descriptor)`                  | Router middleware authenticating a route of the host's own.       |
| `bearerTokenOf(authorization)`         | The bearer token of an `Authorization` header value, an `Option`. |
| `refusalResponse(error, options?)`     | A refusal's response, for a caller the router never routes.       |
| `Protection`, `RefusalResponseOptions` | What `protect` returns, and what `refusalResponse` takes.         |

| `refusalResponse` option | Meaning                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `authentication`         | The descriptor refusing: needed for an error it declares, or a scheme other than Bearer. |
| `protectedResource`      | The resource `layer` was given: challenges name its metadata URL and `scopesRequired`.   |
| `authorization`          | The request's `Authorization` header: a 401 to a presented token says `invalid_token`.   |

## Read request context in a verifier

A verifier may read per-request services: the request, or one of your own, such as the tenant a
request addresses, which native router middleware provides. Provide that middleware after the
provider, in a `Layer.provide` of its own; in one array, the members provide to the routes and
not to one another, and the tenant stays owed:

```ts
routes.pipe(Layer.provide(authenticate), Layer.provide(resolveTenant.layer));
```

See [kitchen-sink/src/workspaces/tenant.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/workspaces/tenant.ts)
and [kitchen-sink/src/identity/authenticate.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/authenticate.ts).

- Router middleware provided around the routes runs before their authentication. Middleware
  that reads the identity runs inside it: give it to the layer as its own `middleware`
  ([ActionHttp.md](ActionHttp.md#serve-the-routes), [ActionRpc.md](ActionRpc.md#serve-the-rpcs)).

## Use a scheme other than Bearer

Name the scheme in `make`'s `security`: an API key in a cookie, a header or the query, such as
`HttpApiSecurity.apiKey({ in: "cookie", key: "tracker_session" })`, or `HttpApiSecurity.basic`.
See [kitchen-sink/src/identity/Identity.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/Identity.ts)
and [kitchen-sink/src/identity/authenticate.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/authenticate.ts)
for a session cookie beside Bearer, and [kitchen-sink/src/admin/Admin.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/admin/Admin.ts)
and [kitchen-sink/src/admin/authenticate.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/admin/authenticate.ts)
for an API key in a header.

- OAuth is Bearer's. Another scheme takes no `protectedResource` and nothing steps up under it:
  the scopes a `Forbidden` names there are sent in its JSON and challenge nothing.
- A browser attaches a cookie to any page's request, so refuse a foreign `Origin` before
  authentication reads the cookie
  ([Run a request policy before authentication](#run-a-request-policy-before-authentication)).
  CORS guards the JSON routes alone ([ActionHttp.md](ActionHttp.md#call-the-api-from-a-browser));
  a WebSocket upgrade is never preflighted, so for rpcs over a socket under a cookie that policy
  is the only check ([ActionRpc.md](ActionRpc.md#send-request-context-with-a-call)).
- A scheme the deployment decides, such as a cookie name a framework prefixes over HTTPS, is
  still one declaration: the server builds its descriptor and its binding at startup, under the
  same name and identity, and a browser's binding keeps a static one.
- Basic's credential reaches the verifier when its username or its password is non-empty, so a
  verifier may receive an empty username.

## Protect a route of your own

A descriptor covers action routes alone. A route of the host's own, such as a download or a
WebSocket upgrade, takes `Authentication.protect(descriptor)`:

```ts
HttpRouter.add("GET", "/attachments/:id", handler).pipe(
  Layer.provide(Authentication.protect(Session).layer),
);
```

It answers a refusal the route fails with as an action's is answered. See
[kitchen-sink/src/attachments/download.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/attachments/download.ts)
and [kitchen-sink/test/attachments/attachments.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/attachments/attachments.test.ts).

- No authorizer runs for such a route: it states its own authorization.
- Every response to a request authentication covers is `Cache-Control: no-store` unless the
  route states its own caching. A route that does says `private` unless its answer is the same
  for every caller, or a cache in front of the server may serve it to anyone.
- The route of an RPC protocol needs no `protect`: `ActionRpc.layer` authenticates each
  message itself.

## Run a request policy before authentication

A check that must refuse a request before its credential is read, such as a `Host` or `Origin`
allowlist, is not the layer's own `middleware`, which runs inside authentication. Make it
global router middleware, `HttpRouter.middleware(check, { global: true })`, which covers every
request of the router, and provide it last:

```ts
routes.pipe(Layer.provide(authenticate), Layer.provide(requestPolicy));
```

See [kitchen-sink/src/request-policy.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/request-policy.ts),
`publicRoutes` in [kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts) and
[kitchen-sink/test/request-policy.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/request-policy.test.ts).

- **An MCP endpoint's `allowedOrigins` checks no `Host`.** It refuses only an unlisted `Origin`:
  a request sending none passes, whatever its `Host`. The example's policy refuses a `Host` that
  is neither loopback nor the public URL's, the check against DNS rebinding.
- **The order decides whether the policy covers discovery.** Global middleware runs in the
  order it registers, a provider publishing a protected resource registers its discovery when
  it is built, and the layer provided last is built first. A policy merged beside the routes,
  with the provider provided around the merge, registers after the provider, and a foreign
  `Host` reads the discovery document.

## Refuse outside the router

A caller the router never routes, such as a Node `upgrade` handler admitting a socket, holds a
header and no request. Read the token with `bearerTokenOf`, verify it with the verifier the
routes use, and answer a refusal with `refusalResponse` ([options](#api)):

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

- `protectedResource` is a value, not the Effect building it: where `layer` builds the resource
  from configuration, build the handler's from the same configuration.
