# Authentication

Two helpers for hosts that own identity: router middleware that provides a request-scoped
identity service, and RFC 9728 protected-resource discovery with bearer challenges. Token
verification, login, and consent stay in the application. Authorization is a group's
pre-handler hook ([ActionGroup.md](ActionGroup.md)), not part of this module.

## API

```ts
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";

/** Provide `service` on every request, or send the response `authenticate` fails with. */
const middleware: <I, A, R>(
  service: Context.Key<I, A>,
  authenticate: Effect.Effect<A, HttpServerResponse.HttpServerResponse, R>,
) => HttpRouter.Middleware<{
  provides: I;
  handles: never;
  error: never;
  requires: Exclude<R, HttpRouter.Provided>;
  layerError: never;
  layerRequires: never;
}>;

const protectedResource: (options: ProtectedResourceOptions) => {
  layer: Layer.Layer<never, never, HttpRouter.HttpRouter>; // GET/HEAD /.well-known/oauth-protected-resource<path>
  metadataUrl: string;
  challenge: (challenge?: BearerChallengeOptions) => string; // WWW-Authenticate value
};

interface ProtectedResourceOptions {
  readonly resource: string; // exact OAuth resource identifier; its path and query select the discovery path
  readonly authorizationServers: NonEmptyReadonlyArray<string>;
  readonly scopesSupported?: ReadonlyArray<string>;
  readonly resourceName?: string;
}

interface BearerChallengeOptions {
  readonly error?: "invalid_token" | "insufficient_scope";
  readonly errorDescription?: string;
  readonly scope?: string; // scopes needed for this request, space-separated
}
```

## Canonical

```ts
import { Context, Effect, Layer, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";

interface Actor {
  readonly id: string;
  readonly tenantId: string;
}

// Request-scoped tag. Never provided at startup.
export class CurrentActor extends Context.Service<CurrentActor, Actor>()("app/CurrentActor") {}

class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

const discovery = Authentication.protectedResource({
  resource: "https://api.example.com/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["users:read", "users:write"],
});

// The host renders the failure response: status, body, challenge.
const unauthenticated = HttpServerResponse.schemaJson(Unauthenticated)(
  new Unauthenticated({ message: "A bearer token is required." }),
  { status: 401, headers: { "www-authenticate": discovery.challenge({ error: "invalid_token" }) } },
).pipe(Effect.orDie);

export const authentication = Authentication.middleware(
  CurrentActor,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const actor = yield* verifyToken(request); // Effect<Option<Actor>>

    return Option.isNone(actor) ? yield* Effect.flip(unauthenticated) : actor.value;
  }),
);

export const routes = Layer.mergeAll(
  discovery.layer, // public
  Http.layer(UserApp).pipe(Layer.provide(authentication.layer)),
  mcp.pipe(Layer.provide(authentication.layer)),
);
```

## Rules

- `authenticate` succeeds with the identity value or fails with the `HttpServerResponse` to send. The host owns status, body, and `WWW-Authenticate`.
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
- 401 response lacks `WWW-Authenticate`: the host's failure response did not set it. Use `discovery.challenge(...)` in its headers.
- A typed client reports `Decode error (401 ...)` instead of the failure schema: the response this middleware renders is not declared. Add it to `ActionHttp.make`'s `errors`.
