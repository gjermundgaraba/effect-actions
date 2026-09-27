# Authentication

Helpers for hosts that own identity: how a remote caller proves who they are, and a bearer-token
reader. Authentication is native router middleware the host provides around the HTTP surfaces
that need it, `layer.pipe(Layer.provide(authenticate))`, as around any route. Given an OAuth
protected resource, it also publishes the resource's RFC 9728 discovery and names it in every
challenge, so an MCP client that is refused finds its authorization server and steps up to a
scope it lacks. Token verification, login, and consent stay in the application. Authorization
belongs in the implementation's `before` hook ([guarantees.md](guarantees.md)), not in this
module or the handlers.

## API

Import `@gjermundgaraba/effect-actions/Authentication`.

| API                                               | Purpose                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `make(service, authenticate, protectedResource?)` | A router middleware layer providing an identity service per request, or answering with a refusal. |
| `bearerToken`                                     | The request's bearer token, failing with `Action.Unauthenticated` without one.                    |

`authenticate` is an Effect producing the identity, or failing with `Action.Unauthenticated`,
`Action.Forbidden`, or the `HttpServerResponse` to send instead. The services it yields, such
as a token verifier, are request requirements, like a handler's, which the layer keeps. The
result is the middleware's layer: provide it to the layers whose routes it authenticates,
`ActionHttp.layer`, `ActionMcp.layerHttp` or routes of the host's own.

`protectedResource` is an OAuth protected resource, which `make` publishes and names in every
challenge. Exported type: `Options`.

| Protected resource option | Meaning                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `resource`                | Required exact OAuth resource identifier; its path selects the discovery path. |
| `authorizationServers`    | Required, nonempty: where clients get tokens.                                  |
| `scopesSupported`         | Optional: every scope the resource accepts, which a client requests up front.  |
| `resourceName`            | Optional human-readable name.                                                  |

## Canonical

The example app's identity: authentication of an OAuth protected resource around its protected
routes, answering a missing or unknown token with the built-in 401 and publishing the
resource's discovery. Provide `authenticate` around the layers serving the protected
implementations ([ActionHttp.md](ActionHttp.md#serving), [ActionMcp.md](ActionMcp.md#canonical)).

```ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { actors, CurrentActor } from "./authorization.js";

// DEMO ONLY: a token is an actor's name. Verify real tokens with your authorization
// server's library instead.
const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

// Provides CurrentActor per request, to the routes of every layer it is provided to. A
// missing or unknown token is the built-in `Unauthenticated`: a 401 every client decodes.
// As an OAuth protected resource, it publishes RFC 9728 discovery, public, and every
// challenge names it, so an MCP client that was refused finds the server issuing its tokens.
export const authenticate = Authentication.make(
  CurrentActor,
  Effect.flatMap(Authentication.bearerToken, (token) =>
    isActorToken(token)
      ? Effect.succeed(actors[token])
      : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." })),
  ),
  {
    resource: "http://localhost:3000/mcp",
    authorizationServers: ["https://auth.example.com"],
    scopesSupported: ["users:read", "users:write"],
  },
);
```

## Rules

- `authenticate` succeeds with the identity value or fails with a refusal. `Unauthenticated` is sent as its JSON with **401**; `Forbidden` as its JSON with **403**. Both are the bodies every endpoint declares, so typed clients decode them. An `HttpServerResponse` is sent with its own status and headers, for a status or header that varies per refusal.
- Every response of the routes it covers gets `Cache-Control: no-store`, and every 401 among them without a challenge gets one, whether authentication, a hook or a handler answers it, including failures serialized by enclosing middleware.
- The 401 challenge is `Bearer`, or as a protected resource `Bearer resource_metadata="<metadata URL>"`. It names no error code and no scope: a client re-authenticates on any 401, and requests `scopesSupported` when a 401 names none.
- A `Forbidden` naming `scopes`, whether `authenticate`, a hook or a handler fails with it, is a **403** with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<scopes>"`, plus `resource_metadata` as a protected resource and `error_description` when the message is a valid one (printable ASCII without `"` or `\`). An OAuth client re-authorizes on it with those scopes added, as MCP authorization requires; the official MCP client does. A `Forbidden` naming no scope has no challenge.
- It authenticates any credential: `authenticate` is any Effect, reading a bearer token, a session cookie or an API key. For another scheme, fail with an `HttpServerResponse` carrying its own challenge, which is kept; a 401 without one gets `Bearer`. A 401 carries a challenge only under `make`.
- `authenticate` can fail with nothing else: any other error is a type error. Map a verifier's failure to a refusal.
- `bearerToken` reads `Authorization: Bearer <token>`, the scheme case-insensitively. Without the header or with another scheme it fails with `Unauthenticated` (`A bearer token is required.`); where a token is optional, `Effect.option(bearerToken)`. Verifying the token stays the host's.
- Provided to a layer, it covers that layer's routes, before decoding, and no others: `ActionHttp.layer(Http, guarded).pipe(Layer.provide(authenticate))` beside a public `ActionHttp.layer(Http, open)` keeps the public routes public. An MCP endpoint is one route: provided to `ActionMcp.layerHttp`, it covers every tool of it.
- It removes the identity from the covered layer's request requirements: [guarantees.md](guarantees.md#dependency-lifetimes).
- Any native router middleware providing the identity works the same way, and sets its own challenges: provide its `.layer`, combined with `.combine(...)` first if it needs another middleware's services.
- A local surface has no remote caller: the host provides the identity service itself, as `Effect.provideService(CurrentActor, actor)`. The `before` hook still runs.
- Services `authenticate` yields other than the request are request requirements, like a handler's, which the layer keeps as `HttpRouter.Request.From<"Requires", R>`, and so every layer it covers. `HttpRouter.provideRequest(layer)` builds a layer once and provides it to every request, as a token verifier needs; router middleware provided around it provides a service resolved per request, such as a tenant.
- Resources it acquires in the request scope live until that scope closes, including while the handler runs.
- Downstream action errors are handled by their transport. They are never serialized as authentication failures.
- Never provide `CurrentActor` or any identity or tenant tag in a startup layer or root context: [guarantees.md](guarantees.md#dependency-lifetimes).
- A protected resource's discovery is published with the layer, however many layers it is provided to, and needs no route of its own. It publishes what it is given: the deployment must ensure `resource` and `authorizationServers` are valid OAuth URLs (HTTPS, or loopback HTTP in development).
- Discovery is served at `/.well-known/oauth-protected-resource` followed by the resource's path (`/.well-known/oauth-protected-resource/mcp` for `https://host/mcp`), for `GET` and `HEAD`, matching that literal path and query. It answers before routing, so no route middleware, the authentication publishing it included, covers it. Other requests fall through to the host router. Caching policy is the host's.
- A host with two resources, or a protected resource beside a cookie-authenticated dashboard, makes one `make` call per resource or scheme.
- Tool discovery is never filtered by actor. Authorization belongs in the implementation's `before` hook, which runs with the action contract in hand; write the rule against `action.access` rather than repeating a check in each handler.

## Failure modes

- Handler sees a stale or wrong actor: an identity tag was provided at startup. Remove it from every startup layer; provide it only through the authentication.
- Type error `HttpRouter.Request.From<"Requires", CurrentActor>` unsatisfied: no authentication is provided around the layer serving a handler or hook that reads the identity. Provide it, `Layer.provide(authenticate)`.
- An action that must be authenticated answers without credentials: its layer has no authentication around it, and nothing it runs reads the identity, so no type asks for one. Provide the authentication around that layer too.
- A public action demands credentials: it is served by a layer the authentication covers, such as one MCP endpoint with the protected tools. Serve it from a layer of its own.
- Type error at `make`: `authenticate` may fail with an error that is neither a refusal nor an `HttpServerResponse`.
- `HttpRouter.Request.From<"Requires", Verifier>` unsatisfied on an HTTP surface: `authenticate` yields it. Provide it per request, as `HttpRouter.provideRequest(Verifier.layer)`, which builds it once; `Layer.provide` does not satisfy a request requirement.
- `"Need to .combine(middleware) that satisfy the missing request dependencies"` on a native middleware's `.layer`: that middleware yields a service. Combine it with middleware providing that service first. `Authentication.make`'s layer keeps such services as requirements instead.
- Discovery returns 404: the request path does not match `resource`'s path and query exactly, or the authentication is provided to no served layer.
- An MCP client does not find the authorization server: discovery is not at the well-known URL for the endpoint's path. Set `resource` to the endpoint's exact URL.
- An MCP client reports `InsufficientScopeError` instead of re-authorizing: it has no OAuth provider configured, so it cannot step up. Configure one, or grant the scope up front.
- `new Action.Forbidden({ scopes })` throws a schema validation error: a scope is not an OAuth scope token (it is empty, or contains a space, `"` or `\`). Give each scope as its own element.
