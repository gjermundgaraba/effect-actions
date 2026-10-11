# Authentication beyond a bearer token

A verifier that reads the request, an API key or a cookie, a route of your own behind the same
sign-in, a policy that runs before authentication, and a refusal outside the router. Declaring a
sign-in and verifying it are in [Authentication.md](Authentication.md).

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
