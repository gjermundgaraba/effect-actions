# Authentication

Helpers for hosts that own identity: router middleware that provides a request-scoped identity
service, a bearer-token reader, and RFC 9728 protected-resource discovery with bearer
challenges. Token
verification, login, and consent stay in the application. Authorization belongs in each adapter's
`before` hook ([guarantees.md](guarantees.md)), not in this module or the handlers.

## API

Import `@gjermundgaraba/effect-actions/Authentication`.

| API                                        | Purpose                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `middleware(service, authenticate, opts?)` | Native router middleware: provide an identity service per request, or answer with the refusal authentication fails with. |
| `bearerToken`                              | The request's bearer token, as an `Option`.                                                                              |
| `protectedResource(options)`               | Public RFC 9728 discovery routes, metadata URL and bearer challenge builder.                                             |
| `discovery.layer`, `discovery.metadataUrl` | Router layer and public discovery URL.                                                                                   |
| `discovery.challenge(options?)`            | Escaped `WWW-Authenticate` header value.                                                                                 |

`authenticate` is an Effect producing the identity, or failing with a declared error from
`opts.errors` or with the `HttpServerResponse` to send. Its dependencies remain request
requirements. Provide the returned middleware's `.layer` to routes requiring that identity.

| Option type                | Fields                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MiddlewareOptions`        | Optional `errors` (schemas `authenticate` may fail with) and `headers` (static, or a function of the error). |
| `ProtectedResourceOptions` | Required `resource` and nonempty `authorizationServers`; optional `scopesSupported`, `resourceName`.         |
| `BearerChallengeOptions`   | Optional `error` (`invalid_token` or `insufficient_scope`), `errorDescription`, and space-separated `scope`. |

## Canonical

The example app's identity: public discovery, and middleware answering a missing or
unknown token with a declared 401 and its challenge. Mount `discovery.layer` beside the
routes, and provide `authentication.layer` to each layer whose handlers need `CurrentActor`
([ActionHttp.md](ActionHttp.md#serving), [ActionMcp.md](ActionMcp.md#canonical)).

```ts
import { Effect, Option } from "effect";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { actors, CurrentActor, Unauthenticated } from "./auth.js";

// RFC 9728 discovery, public: where a client learns which server issues its tokens.
export const discovery = Authentication.protectedResource({
  resource: "http://localhost:3000/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["users:read", "users:write"],
});

// DEMO ONLY: a token is an actor's name. Verify real tokens with your authorization
// server's library instead.
const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

// Provides CurrentActor per request. A refusal is a declared error: sent as its JSON with
// its `httpApiStatus` (401), plus the challenge. The binding declares it too, so what is
// sent is what clients decode.
export const authentication = Authentication.middleware(
  CurrentActor,
  Effect.flatMap(Authentication.bearerToken, (token) =>
    Option.isSome(token) && isActorToken(token.value)
      ? Effect.succeed(actors[token.value])
      : Effect.fail(new Unauthenticated({ message: "A demo bearer token is required." })),
  ),
  { errors: [Unauthenticated], headers: { "www-authenticate": discovery.challenge() } },
);
```

## Rules

- `authenticate` succeeds with the identity value or fails with a refusal. A declared error, one of `errors`, is sent as its JSON encoding with its `httpApiStatus` (500 without one) and `headers`, the same body `ActionHttp` sends for it. An `HttpServerResponse` is sent as it is, for a status or header that varies per refusal. The host owns both.
- An error `authenticate` fails with that is neither declared nor a response is a defect: an empty 500.
- Declare in `errors` what `authenticate` fails with, and declare the same schemas in `ActionHttp.make`'s `errors`, so what this middleware sends is what clients decode. Passing the binding's `Http.errors` does both at once. `headers` is static, or a function of the refusal, so a challenge goes only with the 401 and not with, say, a 429.
- `bearerToken` reads `Authorization: Bearer <token>`, the scheme case-insensitively. It is `Option.none()` without the header or with another scheme. Verifying the token stays the host's.
- Provide the middleware's `.layer` to each HTTP route layer and MCP endpoint layer that needs identity. It is native `HttpRouter.middleware`; combine with `.combine(...)`.
- Its dependencies are request requirements. Resources it acquires live until the request scope closes, including while the handler runs.
- Every response through the middleware carries `Cache-Control: no-store`, including failures serialized by enclosing middleware.
- Downstream action errors are handled by their transport. They are never serialized as authentication failures.
- Use distinct tags for startup capabilities and request identities. Never provide `CurrentActor` or any identity or tenant tag in a startup layer or root context. Native context capture can let a startup value shadow the request value or satisfy a missing one, and the adapters add no isolation boundary. Types track that the tag is required, not where its value came from.
- `protectedResource` publishes what it is given. The deployment must ensure `resource` and `authorizationServers` are valid OAuth URLs (HTTPS, or loopback HTTP in development).
- Discovery is served at `/.well-known/oauth-protected-resource` followed by the resource's path and query, for `GET` and `HEAD`, matching that literal path and query. Other requests fall through to the host router. Mount `discovery.layer` outside the authenticated layers. Caching policy is the host's.
- `challenge()` quotes and escapes parameter values; it never rejects them. Name only the scopes needed for the request in `scope`; `scopesSupported` advertises the full set in metadata.
- Tool discovery is never filtered by actor. Authorization belongs in each surface's `before` hook, which runs with the action contract in hand; write the rule against `action.access` rather than repeating a check in each handler.
- A response this middleware renders is not part of any endpoint's contract. Declare its schema in `ActionHttp.make`'s `errors` so typed clients decode the 401 instead of reporting a decode error ([ActionHttp.md](ActionHttp.md)).

## Failure modes

- Handler sees a stale or wrong actor: an identity tag was provided at startup. Remove it from every startup layer; provide it only through the middleware.
- Type error `HttpRouter.Request.From<"Requires", CurrentActor>` unsatisfied: the layer serving that implementation was not wrapped with `authentication.layer`.
- Discovery returns 404: the request path does not match `resource`'s path and query exactly, or `discovery.layer` is not merged into the served layer.
- Discovery requires a token: `discovery.layer` was placed under the authentication middleware. Mount it separately.
- 401 response lacks `WWW-Authenticate`: no `headers` option, or a response without it. Use `discovery.challenge(...)` in its headers.
- A refusal is an empty 500: `authenticate` failed with an error not in `errors`. Declare it.
- Type error at `middleware`: `authenticate` may fail with an error neither declared in `errors` nor an `HttpServerResponse`.
- A typed client reports `Decode error (401 ...)` instead of the failure schema: the response this middleware renders is not declared. Add it to `ActionHttp.make`'s `errors`.
