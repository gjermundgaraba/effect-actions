# Authentication

Helpers for hosts that own identity: how a remote caller proves who they are, a bearer-token
reader, and RFC 9728 protected-resource discovery. Authentication is native router middleware
the host provides around the HTTP surfaces that need it, `layer.pipe(Layer.provide(authenticate))`,
as around any route. Token verification, login, and consent stay in the application. Authorization belongs
in the implementation's `before` hook ([guarantees.md](guarantees.md)), not in this module or
the handlers.

## API

Import `@gjermundgaraba/effect-actions/Authentication`.

| API                           | Purpose                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `make(service, authenticate)` | A router middleware layer providing an identity service per request, or answering with a refusal. |
| `bearerToken`                 | The request's bearer token, failing with `Action.Unauthenticated` without one.                    |
| `protectedResource(options)`  | A router layer serving public RFC 9728 discovery at the well-known URL.                           |

`authenticate` is an Effect producing the identity, or failing with `Action.Unauthenticated`,
`Action.Forbidden`, or the `HttpServerResponse` to send instead. The services it yields, such
as a token verifier, are request requirements, like a handler's, which the layer keeps. The
result is the middleware's layer: provide it to the layers whose routes it authenticates,
`ActionHttp.layer`, `ActionMcp.layerHttp` or routes of the host's own.

| `protectedResource` option | Meaning                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `resource`                 | Required exact OAuth resource identifier; its path selects the discovery path. |
| `authorizationServers`     | Required, nonempty: where clients get tokens.                                  |
| `scopesSupported`          | Optional: every scope the resource accepts.                                    |
| `resourceName`             | Optional human-readable name.                                                  |

## Canonical

The example app's identity: public discovery, and the authentication around its guarded
routes, answering a missing or unknown token with the built-in 401. Mount `discovery` beside
the routes; provide `authenticate` around the layers serving the guarded implementations
([ActionHttp.md](ActionHttp.md#serving), [ActionMcp.md](ActionMcp.md#canonical)).

```ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { actors, CurrentActor } from "./authorization.js";

// RFC 9728 discovery, public: where an MCP client that was refused finds the server that
// issues its tokens.
export const discovery = Authentication.protectedResource({
  resource: "http://localhost:3000/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["users:read", "users:write"],
});

// DEMO ONLY: a token is an actor's name. Verify real tokens with your authorization
// server's library instead.
const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

// Provides CurrentActor per request, to the routes of every layer it is provided to. A
// missing or unknown token is the built-in `Unauthenticated`: a 401 every client decodes,
// with a `Bearer` challenge.
export const authenticate = Authentication.make(
  CurrentActor,
  Effect.flatMap(Authentication.bearerToken, (token) =>
    isActorToken(token)
      ? Effect.succeed(actors[token])
      : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." })),
  ),
);
```

## Rules

- `authenticate` succeeds with the identity value or fails with a refusal. `Unauthenticated` is sent as its JSON with **401** and `WWW-Authenticate: Bearer`; `Forbidden` as its JSON with **403** and no challenge. Both are the bodies every endpoint declares, so typed clients decode them. An `HttpServerResponse` is sent as it is, for a status or header that varies per refusal.
- `authenticate` can fail with nothing else: any other error is a type error. Map a verifier's failure to a refusal.
- The challenge is the plain `Bearer`, with no `resource_metadata` parameter. MCP requires a server to publish its metadata location through the header or the well-known URL, and clients to fall back to probing the well-known URL, so `protectedResource` is the discovery. To name the metadata URL, a scope or an `error` in the challenge, fail with an `HttpServerResponse` carrying your own header.
- `bearerToken` reads `Authorization: Bearer <token>`, the scheme case-insensitively. Without the header or with another scheme it fails with `Unauthenticated` (`A bearer token is required.`); where a token is optional, `Effect.option(bearerToken)`. Verifying the token stays the host's.
- Provided to a layer, it covers that layer's routes, before decoding, and no others: `ActionHttp.layer(Http, guarded).pipe(Layer.provide(authenticate))` beside a public `ActionHttp.layer(Http, open)` keeps the public routes public. An MCP endpoint is one route: provided to `ActionMcp.layerHttp`, it covers every tool of it.
- It removes the identity from the covered layer's request requirements. A handler or hook that reads the identity is a type error until then; one that reads none is not, so wrap every layer serving an implementation that must be authenticated.
- Any native router middleware providing the identity works the same way: provide its `.layer`, combined with `.combine(...)` first if it needs another middleware's services.
- Local surfaces, the CLI, the Toolkit and MCP over stdio, have no remote caller: nothing authenticates, and the host provides the identity service itself, as `Effect.provideService(CurrentActor, actor)`. The `before` hook still runs.
- Services `authenticate` yields other than the request are request requirements, like a handler's, which the layer keeps as `HttpRouter.Request.From<"Requires", R>`, and so every layer it covers. `HttpRouter.provideRequest(layer)` builds a layer once and provides it to every request, as a token verifier needs; router middleware provided around it provides a service resolved per request, such as a tenant.
- Resources it acquires in the request scope live until that scope closes, including while the handler runs.
- Every response through the authentication carries `Cache-Control: no-store`, including failures serialized by enclosing middleware.
- Downstream action errors are handled by their transport. They are never serialized as authentication failures.
- Use distinct tags for startup capabilities and request identities. Never provide `CurrentActor` or any identity or tenant tag in a startup layer or root context. Native context capture can let a startup value shadow the request value or satisfy a missing one, and the surfaces add no isolation boundary. Types track that the tag is required, not where its value came from.
- `protectedResource` publishes what it is given. The deployment must ensure `resource` and `authorizationServers` are valid OAuth URLs (HTTPS, or loopback HTTP in development).
- Discovery is served at `/.well-known/oauth-protected-resource` followed by the resource's path (`/.well-known/oauth-protected-resource/mcp` for `https://host/mcp`), for `GET` and `HEAD`, matching that literal path and query. Other requests fall through to the host router. Mount it outside the authenticated layers. Caching policy is the host's.
- Tool discovery is never filtered by actor. Authorization belongs in the implementation's `before` hook, which runs with the action contract in hand; write the rule against `action.access` rather than repeating a check in each handler.

## Failure modes

- Handler sees a stale or wrong actor: an identity tag was provided at startup. Remove it from every startup layer; provide it only through the authentication.
- Type error `HttpRouter.Request.From<"Requires", CurrentActor>` unsatisfied: no authentication is provided around the layer serving a handler or hook that reads the identity. Provide it, `Layer.provide(authenticate)`.
- A guarded action answers without credentials: its layer has no authentication around it, and nothing it runs reads the identity, so no type asks for one. Provide the authentication around that layer too.
- A public action demands credentials: it is served by a layer the authentication covers, such as one MCP endpoint with the guarded tools. Serve it from a layer of its own.
- Type error at `make`: `authenticate` may fail with an error that is neither a refusal nor an `HttpServerResponse`.
- `HttpRouter.Request.From<"Requires", Verifier>` unsatisfied on an HTTP surface: `authenticate` yields it. Provide it per request, as `HttpRouter.provideRequest(Verifier.layer)`, which builds it once; `Layer.provide` does not satisfy a request requirement.
- `"Need to .combine(middleware) that satisfy the missing request dependencies"` on a native middleware's `.layer`: that middleware yields a service. Combine it with middleware providing that service first. `Authentication.make`'s layer keeps such services as requirements instead.
- Discovery returns 404: the request path does not match `resource`'s path and query exactly, or the `protectedResource` layer is not merged into the served layer.
- Discovery requires a token: the `protectedResource` layer was placed under authentication middleware. Mount it separately.
- An MCP client does not find the authorization server: discovery is not at the well-known URL for the endpoint's path. Set `resource` to the endpoint's exact URL.
