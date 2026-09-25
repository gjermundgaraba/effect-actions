# Authentication

Helpers for hosts that own identity: router middleware that provides a request-scoped identity
service, a bearer-token reader, and RFC 9728 protected-resource discovery. Token
verification, login, and consent stay in the application. Authorization belongs in each
surface's `before` hook ([guarantees.md](guarantees.md)), not in this module or the handlers.

## API

Import `@gjermundgaraba/effect-actions/Authentication`.

| API                                 | Purpose                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `middleware(service, authenticate)` | Native router middleware: provide an identity service per request, or answer with a refusal. |
| `bearerToken`                       | The request's bearer token, as an `Option`.                                                  |
| `protectedResource(options)`        | A router layer serving public RFC 9728 discovery at the well-known URL.                      |

`authenticate` is an Effect producing the identity, or failing with `Action.Unauthenticated`,
`Action.Forbidden`, or the `HttpServerResponse` to send instead. Its dependencies remain
request requirements. Provide the returned middleware's `.layer` to routes requiring that
identity.

| `protectedResource` option | Meaning                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `resource`                 | Required exact OAuth resource identifier; its path selects the discovery path. |
| `authorizationServers`     | Required, nonempty: where clients get tokens.                                  |
| `scopesSupported`          | Optional: every scope the resource accepts.                                    |
| `resourceName`             | Optional human-readable name.                                                  |

## Canonical

The example app's identity: public discovery, and middleware answering a missing or
unknown token with the built-in 401. Mount `discovery` beside the routes, and provide
`authentication.layer` to each layer whose handlers need `CurrentActor`
([ActionHttp.md](ActionHttp.md#serving), [ActionMcp.md](ActionMcp.md#canonical)).

```ts
import { Effect, Option } from "effect";
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

// Provides CurrentActor per request. A refusal is the built-in `Unauthenticated`: a 401
// every client decodes, with a `Bearer` challenge.
export const authentication = Authentication.middleware(
  CurrentActor,
  Effect.flatMap(Authentication.bearerToken, (token) =>
    Option.isSome(token) && isActorToken(token.value)
      ? Effect.succeed(actors[token.value])
      : Effect.fail(new Action.Unauthenticated({ message: "A demo bearer token is required." })),
  ),
);
```

## Rules

- `authenticate` succeeds with the identity value or fails with a refusal. `Unauthenticated` is sent as its JSON with **401** and `WWW-Authenticate: Bearer`; `Forbidden` as its JSON with **403** and no challenge. Both are the bodies every endpoint declares, so typed clients decode them. An `HttpServerResponse` is sent as it is, for a status or header that varies per refusal.
- `authenticate` can fail with nothing else: any other error is a type error. Map a verifier's failure to a refusal.
- The challenge is the plain `Bearer`, with no `resource_metadata` parameter. MCP requires a server to publish its metadata location through the header or the well-known URL, and clients to fall back to probing the well-known URL, so `protectedResource` is the discovery. To name the metadata URL, a scope or an `error` in the challenge, fail with an `HttpServerResponse` carrying your own header.
- `bearerToken` reads `Authorization: Bearer <token>`, the scheme case-insensitively. It is `Option.none()` without the header or with another scheme. Verifying the token stays the host's.
- Provide the middleware's `.layer` to each HTTP route layer and MCP endpoint layer that needs identity. It is native `HttpRouter.middleware`; combine with `.combine(...)`.
- Its dependencies are request requirements. Resources it acquires live until the request scope closes, including while the handler runs.
- Every response through the middleware carries `Cache-Control: no-store`, including failures serialized by enclosing middleware.
- Downstream action errors are handled by their transport. They are never serialized as authentication failures.
- Use distinct tags for startup capabilities and request identities. Never provide `CurrentActor` or any identity or tenant tag in a startup layer or root context. Native context capture can let a startup value shadow the request value or satisfy a missing one, and the surfaces add no isolation boundary. Types track that the tag is required, not where its value came from.
- `protectedResource` publishes what it is given. The deployment must ensure `resource` and `authorizationServers` are valid OAuth URLs (HTTPS, or loopback HTTP in development).
- Discovery is served at `/.well-known/oauth-protected-resource` followed by the resource's path (`/.well-known/oauth-protected-resource/mcp` for `https://host/mcp`), for `GET` and `HEAD`, matching that literal path and query. Other requests fall through to the host router. Mount it outside the authenticated layers. Caching policy is the host's.
- Tool discovery is never filtered by actor. Authorization belongs in each surface's `before` hook, which runs with the action contract in hand; write the rule against `action.access` rather than repeating a check in each handler.

## Failure modes

- Handler sees a stale or wrong actor: an identity tag was provided at startup. Remove it from every startup layer; provide it only through the middleware.
- Type error `HttpRouter.Request.From<"Requires", CurrentActor>` unsatisfied: the layer serving that implementation was not wrapped with `authentication.layer`.
- Type error at `middleware`: `authenticate` may fail with an error that is neither a refusal nor an `HttpServerResponse`.
- Discovery returns 404: the request path does not match `resource`'s path and query exactly, or the `protectedResource` layer is not merged into the served layer.
- Discovery requires a token: the `protectedResource` layer was placed under the authentication middleware. Mount it separately.
- An MCP client does not find the authorization server: discovery is not at the well-known URL for the endpoint's path. Set `resource` to the endpoint's exact URL.
