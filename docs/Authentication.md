# Authentication

Helpers for hosts that own identity: how a remote caller proves who they are, and a bearer-token
reader. Authentication is Effect's native router middleware, built like a handler: the host
provides its layer around the HTTP surfaces that need it, `layer.pipe(Layer.provide(authenticate))`,
as around any route, and combines it with middleware of its own natively. Given an OAuth
protected resource, it also publishes the resource's RFC 9728 discovery and names it in every
challenge, so an MCP client that is refused finds its authorization server and steps up to a
scope it lacks. Token verification, login, and consent stay in the application. Action-level
authorization belongs in the implementation's `before` hook; record-level checks belong in
the handler's data access ([guarantees.md](guarantees.md#authorization)).

## API

Import `@gjermundgaraba/effect-actions/Authentication`.

| API                                        | Purpose                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `make(service, build, protectedResource?)` | Effect's `HttpRouter.Middleware`, providing an identity service per request or answering with a refusal. |
| `bearerToken`                              | The request's bearer token, `Redacted`, failing with `Action.Unauthenticated` without one.               |

`build` is a builder, like the one `Action.implement` takes ([Action.md](Action.md#implementations)):
an Effect that yields startup services, such as a token verifier, and returns the per-request
authentication. With no startup services it is `Effect.succeed(authenticate)`: a builder and a
per-request Effect are both Effects, so there is no plain form.

The per-request authentication is an Effect producing the identity, or failing with
`Action.Unauthenticated`, `Action.Forbidden`, or the `HttpServerResponse` to send instead. It
reads the request the router provides; another service it reads per request comes from
middleware combined before it.

The result is middleware: provide its `.layer` to the layers whose routes it authenticates,
`ActionHttp.layer`, `ActionMcp.layerHttp` or routes of the host's own. `.combine` composes it
with other middleware first: `authentication.combine(resolveTenant)` resolves the tenant
before authenticating, `accessLog.combine(authentication)` reads the identity after.

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
resource's discovery. Provide its layer, `authenticate`, around the layers serving the protected
implementations ([ActionHttp.md](ActionHttp.md#serving), [ActionMcp.md](ActionMcp.md#canonical)).

```ts
import { Effect, Redacted } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { actors, CurrentActor } from "./authorization.js";

// DEMO ONLY: a token is an actor's name. Verify real tokens with your authorization
// server's library instead.
const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

// Router middleware providing CurrentActor per request. Like a handler builder, its Effect
// yields startup services, such as a token verifier, and returns the per-request
// authentication; this demo needs none. A missing or unknown token is the built-in
// `Unauthenticated`: a 401 every client decodes. As an OAuth protected resource, it
// publishes RFC 9728 discovery, public, and every challenge names it, so an MCP client
// that was refused finds the server issuing its tokens. A first login requests read only;
// a write refused for its scope steps up.
export const authentication = Authentication.make(
  CurrentActor,
  Effect.succeed(
    Effect.flatMap(Authentication.bearerToken, (token) => {
      const name = Redacted.value(token);

      return isActorToken(name)
        ? Effect.succeed(actors[name])
        : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
    }),
  ),
  {
    resource: "http://localhost:3000/mcp",
    authorizationServers: ["https://auth.example.com"],
    scopesSupported: ["users:read", "users:write"],
    scopesRequired: ["users:read"],
  },
);

// Provided to every layer whose routes it authenticates. Combine the middleware first when
// it reads another middleware's service, or another reads the identity.
export const authenticate = authentication.layer;
```

### Combined with other middleware

A host serving tenants on their own subdomains: a verifier built once at startup, each
request's tenant from middleware combined before the authentication, and middleware reading
the identity combined after it.

```ts
import { Context, Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { type Actor, actors, CurrentActor } from "./authorization.js";

/** Each request's tenant: the first label of its host, `acme` for acme.example.com. */
export class Tenant extends Context.Service<Tenant, string>()("example/Tenant") {}

const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.provideService(route, Tenant, request.headers.host?.split(".")[0] ?? ""),
  ),
);

// Reads the identity: names the authenticated caller on each response.
const logCaller = HttpRouter.middleware()((route) =>
  Effect.flatMap(CurrentActor, ({ id }) =>
    Effect.map(route, HttpServerResponse.setHeader("x-actor", id)),
  ),
);

/** DEMO ONLY: a startup service verifying tokens, as your authorization server's library would. */
export class Verifier extends Context.Service<
  Verifier,
  {
    readonly verify: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<Actor, Action.Unauthenticated>;
  }
>()("example/Verifier") {
  static readonly layer = Layer.sync(Verifier, () => {
    const known = new Map<string, Actor>(Object.entries(actors));

    return Verifier.of({
      verify: (token) =>
        Effect.fromNullishOr(known.get(Redacted.value(token))).pipe(
          Effect.mapError(() => new Action.Unauthenticated({ message: "Unknown demo token." })),
        ),
    });
  });
}

// Like a handler builder: the verifier once, at startup; the token and the tenant per
// request. An actor of another tenant is refused.
const authentication = Authentication.make(
  CurrentActor,
  Effect.gen(function* () {
    const verifier = yield* Verifier;

    return Effect.gen(function* () {
      const actor = yield* verifier.verify(yield* Authentication.bearerToken);

      if (actor.tenantId !== (yield* Tenant)) {
        return yield* new Action.Forbidden({ message: "Not a member of this tenant." });
      }

      return actor;
    });
  }),
);

// `resolveTenant` runs first, providing what the authentication reads; `logCaller` runs
// last, reading the identity the authentication provides.
export const authenticate = logCaller
  .combine(authentication.combine(resolveTenant))
  .layer.pipe(Layer.provide(Verifier.layer));
```

## Rules

- The per-request authentication succeeds with the identity value or fails with a refusal. `Unauthenticated` is sent as its JSON with **401**; `Forbidden` as its JSON with **403**. Both are the bodies every endpoint declares, so typed clients decode them. An `HttpServerResponse` is sent with its own status and headers, for a status or header that varies per refusal.
- Every response of the routes it covers gets `Cache-Control: no-store` unless its route states its own caching, such as `private, max-age=31536000, immutable` for a content-addressed download. A failure enclosing middleware serializes always gets `no-store`, whatever caching it states.
- Every 401 among them without a challenge gets one, whether authentication, a hook or a handler answers it, including failures serialized by enclosing middleware.
- The 401 challenge is `Bearer`, or as a protected resource `Bearer scope="<scopesRequired>", resource_metadata="<metadata URL>"`, `scope` only when `scopesRequired` is given.
- A 401 to a request that presented a bearer token also names `error="invalid_token"` first (RFC 6750), whoever refused it: the token did not authenticate it, and a client may refresh it before it signs in again. A request without one, or with another scheme such as `Basic`, gets no error code.
- An MCP client requests the scopes a 401 names, or every one of `scopesSupported` when it names none. Give `scopesRequired` whenever some scopes are needed only by some actions, so a first login asks for the least, and a `Forbidden` naming scopes asks for more when a call needs them.
- Step-up refusals follow [guarantees.md](guarantees.md#authorization), including the MCP exception when a notification has already started the **200** stream: a later refusal is an `isError` tool result without an HTTP challenge.
- When a `Forbidden` naming `scopes` is sent as an HTTP refusal, its **403** carries `WWW-Authenticate: Bearer error="insufficient_scope", scope="<scopes>"`. As a protected resource it adds `resource_metadata`, and `error_description` when the message is a valid one (printable ASCII without `"` or `\`).
- An OAuth client re-authorizes on that challenge with those scopes added, as MCP authorization requires; the official MCP client does. A `Forbidden` naming no scope has no challenge ([guarantees.md](guarantees.md#authorization)).
- Name scopes only when re-authorizing can grant them. A caller whose credential cannot step up, such as an API key, gets a `Forbidden` naming none: a plain 403, and a tool result over MCP, rather than a login prompt that cannot help.
- A WebSocket upgrade is a router route, such as `RpcServer.layerProtocolWebsocket`'s: provide the middleware's layer to it as to any other.
- It authenticates any credential: the per-request authentication is any Effect, reading a bearer token, a session cookie or an API key. For another scheme, fail with an `HttpServerResponse` carrying its own challenge, which is kept; a 401 without one gets `Bearer`. A 401 carries a challenge only under `make`.
- The per-request authentication can fail with nothing else: any other error is a type error. Map a verifier's failure to a refusal.
- `bearerToken` reads `Authorization: Bearer <token>`, the scheme case-insensitively. Without the header or with another scheme it fails with `Unauthenticated` (`A bearer token is required.`); where a token is optional, `Effect.option(bearerToken)`. The token is `Redacted`, as `HttpApiSecurity.bearer` gives it, so a log, span or error holding it prints `<redacted>`; read it with `Redacted.value(token)` where it is verified. Verifying the token stays the host's.
- `build` runs when the middleware's layer is built, once per layer graph however many layers and compositions use it, as a handler builder does ([guarantees.md](guarantees.md#dependency-lifetimes)). The services it yields are startup requirements of the middleware's layer: `authentication.layer.pipe(Layer.provide(Verifier.layer))`, or provided above it. A resource it acquires lives as long as the layer; a failure of `build` fails the layer, so the server does not start.
- The services the per-request authentication yields, beyond what the router provides, such as the request and its scope, are request requirements, as a handler's are. Middleware combined before it provides them: `authentication.combine(resolveTenant).layer`. A startup service, such as a verifier, is yielded in `build` instead, never per request.
- Middleware that reads the identity is combined after it, `accessLog.combine(authentication).layer`, and runs only for requests it authenticated; both at once is `accessLog.combine(authentication.combine(resolveTenant)).layer`. In `a.combine(b)`, `b` runs first, around `a`, and provides to it.
- Its layer, provided to a layer, covers that layer's routes, before decoding, and no others: `ActionHttp.layer(Http, guarded).pipe(Layer.provide(authenticate))` beside a public `ActionHttp.layer(Http, open)` keeps the public routes public. An MCP endpoint is one route: provided to `ActionMcp.layerHttp`, it covers every tool of it.
- It removes the identity from the covered layer's request requirements: [guarantees.md](guarantees.md#authorization).
- Other native router middleware providing the identity covers the surfaces the same way, but without `make`'s challenges, step-up answers and discovery.
- A local surface has no remote caller: the host provides the identity service itself, as `Effect.provideService(CurrentActor, actor)`, or on a CLI command, `Command.provideSync(CurrentActor, actor)`. The `before` hook still runs.
- Resources the per-request authentication acquires in the request scope live until that scope closes, including while the handler runs.
- Downstream action errors are handled by their transport. They are never serialized as authentication failures.
- Never provide `CurrentActor` or any identity or tenant tag in a startup layer or root context: [guarantees.md](guarantees.md#dependency-lifetimes).
- A protected resource's discovery is published when the middleware's layer is built, once per layer graph, whichever composition builds it and however many layers it is provided to, and needs no route of its own. It publishes what it is given: the deployment must ensure `resource` and `authorizationServers` are valid OAuth URLs (HTTPS, or loopback HTTP in development).
- Discovery is served at `/.well-known/oauth-protected-resource` followed by the resource's path (`/.well-known/oauth-protected-resource/mcp` for `https://host/mcp`), for `GET` and `HEAD`, matching that literal path and query, and answers the CORS preflight there. It answers before routing, so no route middleware, the authentication publishing it included, covers it. Other requests fall through to the host router. Caching policy is the host's.
- Any origin may read discovery, as a browser MCP client must after a 401: it carries `Access-Control-Allow-Origin: *`, and answers an `OPTIONS` preflight at its URL with **204**, allowing `GET`, `HEAD` and `OPTIONS` and the headers the preflight asks for. Where the host's CORS middleware runs before it, that policy answers discovery's preflight and adds its headers to discovery's reads, so an origin it allows may read discovery, and discovery keeps its `*` where the policy sets no origin. Global middleware runs in the order it registers while layers build, which is the order it is merged in unless something built before it is asynchronous; either way, an origin the host's policy allows may read discovery.
- A host with two resources, or a protected resource beside a cookie-authenticated dashboard, makes one `make` call per resource or scheme.
- Tool discovery is never filtered by actor. Action-level authorization belongs in the implementation's `before` hook, which runs with the action contract in hand; write the rule against `action.access` rather than repeating a check in each handler. Record-level checks follow [guarantees.md](guarantees.md#authorization).

## Failure modes

- A route no authentication covers answers every caller as one actor: an identity tag was provided at startup. Remove it from every startup layer; provide it only through the authentication.
- Type error `HttpRouter.Request.From<"Requires", CurrentActor>` unsatisfied: no authentication is provided around the layer serving a handler or hook that reads the identity. Provide it, `Layer.provide(authenticate)`.
- An action that must be authenticated answers without credentials: its layer has no authentication around it, and nothing it runs reads the identity, so no type asks for one. Provide the authentication around that layer too.
- A public action demands credentials: it is served by a layer the authentication covers, such as one MCP endpoint with the protected tools. Serve it from a layer of its own.
- Type error at `make` that the identity is not an `Effect` (`... is missing the following properties from type 'Effect<...>'`, or `Type 'string' is not assignable to type 'Effect<...>'`): the second argument is the per-request authentication itself. Return it from `build`, or wrap it, `Effect.succeed(authenticate)`.
- `No overload matches this call` at `Layer.provide`, naming `Middleware<{ provides: CurrentActor; ... }>`: the middleware itself was provided. Provide its `.layer`.
- Type error at `make`: the per-request authentication may fail with an error that is neither a refusal nor an `HttpServerResponse`. Map it to a refusal.
- `Verifier` unsatisfied at startup: `build` yields it. Provide it to the middleware's layer, `authentication.layer.pipe(Layer.provide(Verifier.layer))`, or above it.
- `No overload matches this call` at `Layer.provide(authentication.layer)` naming `Argument of type 'string'`, or `Argument of type 'string' is not assignable to parameter of type 'Layer<...>'` where the layer is merged: the per-request authentication reads a service no middleware combined before it provides, so `.layer` is Effect's `"Need to .combine(middleware) that satisfy the missing request dependencies"`, as its hover or `Property 'pipe' does not exist` on `.layer.pipe(...)` shows. Combine one providing it, `authentication.combine(resolveTenant).layer`, not the other way around; yield a startup service, such as a verifier, in `build` instead.
- Discovery returns 404: the request path does not match `resource`'s path and query exactly, or the authentication is provided to no served layer.
- An MCP client does not find the authorization server: discovery is not at the well-known URL for the endpoint's path. Set `resource` to the endpoint's exact URL.
- An MCP client reports `InsufficientScopeError` instead of re-authorizing: it has no OAuth provider configured, so it cannot step up. Configure one, or grant the scope up front.
- `new Action.Forbidden({ scopes })` throws a schema validation error: a scope is not an OAuth scope token (it is empty, or contains a space, `"` or `\`). Give each scope as its own element.
- An MCP client asks a user who only reads to consent to writes on first login: the 401 names no scope, so it requests every one of `scopesSupported`. Give `scopesRequired`.
- `Invalid scope in scopesRequired: "<scope>"` thrown by `make`: a scope is empty or contains a space, `"` or `\`. Give each scope as its own element.
- A route's `Cache-Control` is replaced by `no-store`: an enclosing middleware serialized the response of a failure. Only a route's own answer keeps its caching.
