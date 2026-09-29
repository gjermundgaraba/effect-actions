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

| API                                                  | Purpose                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `make(service, authenticate, protectedResource?)`    | A router middleware layer providing an identity service per request, or answering with a refusal. |
| `bearerToken`                                        | The request's bearer token, `Redacted`, failing with `Action.Unauthenticated` without one.        |
| `refusal(error, protectedResource?, authorization?)` | The response `make` answers a refusal with, for a caller outside the router.                      |

`authenticate` is an Effect producing the identity, or failing with `Action.Unauthenticated`,
`Action.Forbidden`, or the `HttpServerResponse` to send instead. The services it yields, such
as a token verifier, are request requirements, like a handler's, which the layer keeps. The
result is the middleware's layer: provide it to the layers whose routes it authenticates,
`ActionHttp.layer`, `ActionMcp.layerHttp` or routes of the host's own.

`protectedResource` is an OAuth protected resource, which `make` publishes and names in every
challenge. Exported type: `Options`.

| Protected resource option | Meaning                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `resource`                | Required exact OAuth resource identifier; its path selects the discovery path.                |
| `authorizationServers`    | Required, nonempty: where clients get tokens.                                                 |
| `scopesSupported`         | Optional: every scope the resource accepts, published in discovery.                           |
| `scopesRequired`          | Optional, nonempty OAuth scope tokens: every 401 names them, and a first login requests them. |
| `resourceName`            | Optional human-readable name.                                                                 |

## Canonical

The example app's identity: authentication of an OAuth protected resource around its protected
routes, answering a missing or unknown token with the built-in 401 and publishing the
resource's discovery. Provide `authenticate` around the layers serving the protected
implementations ([ActionHttp.md](ActionHttp.md#serving), [ActionMcp.md](ActionMcp.md#canonical)).

```ts
import { Effect, Redacted } from "effect";
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
// A first login requests read only; a write refused for its scope steps up.
export const authenticate = Authentication.make(
  CurrentActor,
  Effect.flatMap(Authentication.bearerToken, (token) => {
    const name = Redacted.value(token);

    return isActorToken(name)
      ? Effect.succeed(actors[name])
      : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
  }),
  {
    resource: "http://localhost:3000/mcp",
    authorizationServers: ["https://auth.example.com"],
    scopesSupported: ["users:read", "users:write"],
    scopesRequired: ["users:read"],
  },
);
```

## Rules

- `authenticate` succeeds with the identity value or fails with a refusal. `Unauthenticated` is sent as its JSON with **401**; `Forbidden` as its JSON with **403**. Both are the bodies every endpoint declares, so typed clients decode them. An `HttpServerResponse` is sent with its own status and headers, for a status or header that varies per refusal.
- Every response of the routes it covers gets `Cache-Control: no-store` unless its route states its own caching, such as `private, max-age=31536000, immutable` for a content-addressed download. A failure enclosing middleware serializes always gets `no-store`, whatever caching it states.
- Every 401 among them without a challenge gets one, whether authentication, a hook or a handler answers it, including failures serialized by enclosing middleware.
- The 401 challenge is `Bearer`, or as a protected resource `Bearer scope="<scopesRequired>", resource_metadata="<metadata URL>"`, `scope` only when `scopesRequired` is given.
- A 401 to a request that presented an `Authorization` header also names `error="invalid_token"` first (RFC 6750), whoever refused it: the credentials did not authenticate it, and a client may refresh its token before it signs in again. A request without credentials gets no error code.
- An MCP client requests the scopes a 401 names, or every one of `scopesSupported` when it names none. Give `scopesRequired` whenever some scopes are needed only by some actions, so a first login asks for the least, and a `Forbidden` naming scopes asks for more when a call needs them.
- A `Forbidden` naming `scopes`, whether `authenticate`, a hook or a handler fails with it, is a **403** with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<scopes>"`. As a protected resource it adds `resource_metadata`, and `error_description` when the message is a valid one (printable ASCII without `"` or `\`).
- An OAuth client re-authorizes on that challenge with those scopes added, as MCP authorization requires; the official MCP client does. A `Forbidden` naming no scope has no challenge ([guarantees.md](guarantees.md#authorization)).
- Name scopes only when re-authorizing can grant them. A caller whose credential cannot step up, such as an API key, gets a `Forbidden` naming none: a plain 403, and a tool result over MCP, rather than a login prompt that cannot help.
- `refusal(error, protectedResource?, authorization?)` is the response `make` answers `error` with: its JSON and status, `no-store`, and the same challenge, naming `protectedResource` as `make` does. Pass the request's `Authorization` header, when it has one, for the `invalid_token` a 401 names then. Refuse with it where no route runs, such as a WebSocket upgrade handled before the router, so every refusal of the resource reads the same. `HttpServerResponse.toWeb` makes it a web `Response`.
- It authenticates any credential: `authenticate` is any Effect, reading a bearer token, a session cookie or an API key. For another scheme, fail with an `HttpServerResponse` carrying its own challenge, which is kept; a 401 without one gets `Bearer`. A 401 carries a challenge only under `make`.
- `authenticate` can fail with nothing else: any other error is a type error. Map a verifier's failure to a refusal.
- `bearerToken` reads `Authorization: Bearer <token>`, the scheme case-insensitively. Without the header or with another scheme it fails with `Unauthenticated` (`A bearer token is required.`); where a token is optional, `Effect.option(bearerToken)`. The token is `Redacted`, as `HttpApiSecurity.bearer` gives it, so a log, span or error holding it prints `<redacted>`; read it with `Redacted.value(token)` where it is verified. Verifying the token stays the host's.
- Provided to a layer, it covers that layer's routes, before decoding, and no others: `ActionHttp.layer(Http, guarded).pipe(Layer.provide(authenticate))` beside a public `ActionHttp.layer(Http, open)` keeps the public routes public. An MCP endpoint is one route: provided to `ActionMcp.layerHttp`, it covers every tool of it.
- It removes the identity from the covered layer's request requirements: [guarantees.md](guarantees.md#authorization).
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
- An MCP client asks a user who only reads to consent to writes on first login: the 401 names no scope, so it requests every one of `scopesSupported`. Give `scopesRequired`.
- `Invalid scope in scopesRequired: "<scope>"` thrown by `make` or `refusal`: a scope is empty or contains a space, `"` or `\`. Give each scope as its own element.
- A route's `Cache-Control` is replaced by `no-store`: an enclosing middleware serialized the response of a failure. Only a route's own answer keeps its caching.
