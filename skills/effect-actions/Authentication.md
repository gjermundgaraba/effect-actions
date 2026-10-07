# Authentication

How a remote caller proves the identity a protected contract declares, and its verification on
the server. A contract states its identity, `caller: CurrentActor` ([Action.md](Action.md#rules)).
`make` declares how a caller proves it: a named, browser-safe descriptor of one native scheme,
Bearer unless it names another, which a binding and an MCP endpoint serving protected actions
name. `layer` is that
descriptor's provider: the server-only verifier, built once per layer graph, which every HTTP or
MCP layer serving protected actions requires, and which authenticates their requests before
decoding them. The surfaces enforce it with Effect's native endpoint security, which also
documents it in OpenAPI. Given an OAuth protected resource, a Bearer provider publishes the resource's
RFC 9728 discovery and names it in every challenge, so an MCP client that is refused finds its
authorization server and steps up to a scope it lacks. Token verification, login, and consent
stay in the application. Action-level authorization belongs in the implementation's
`authorize`; record-level checks belong in the handler's data access
([guarantees.md](guarantees.md#authorization)).

## API

Import `@gjermundgaraba/effect-actions/Authentication`.

| API                                           | Purpose                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `make(name, identity, { security, error }?)`  | A browser-safe authentication descriptor: how a caller proves `identity`, one native scheme.                |
| `layer(descriptor, verify, options?)`         | Its provider: the server-only verifier, or an Effect building it once per layer graph, and discovery.       |
| `protect(descriptor)`                         | Router middleware authenticating a route of the host's own as the descriptor's actions are.                 |
| `bearerTokenOf(authorization)`                | The bearer token of an `Authorization` header value, an `Option`, for a caller the router never routes.     |
| `refusalResponse(error, options?)`            | The response authentication answers a refusal with, for a caller the router never routes.                   |
| `Any`                                         | Any descriptor, erased: what a binding's and an MCP endpoint's `authentication` take.                       |
| `Descriptor`, `Provider`                      | What `make` and `layer` return, to name in a package that emits declarations.                               |
| `Verify`, `Options`, `LayerOptions`           | The verifier's type, of the credential its descriptor's scheme decodes, and `make`'s and `layer`'s options. |
| `ProtectedResource`, `RefusalResponseOptions` | An OAuth protected resource, and what `refusalResponse` takes.                                              |

`name` is a literal, unique per declaration: it names the one provider that satisfies the
descriptor, so a provider of another descriptor of the same identity does not. `security` is one
native `HttpApiSecurity` scheme, `HttpApiSecurity.bearer` when omitted: another is
`HttpApiSecurity.apiKey({ in: "cookie", key: "session" })`, an API key in a header or the query,
or `HttpApiSecurity.basic`. Exported type: `Options`. Options whose `security` may be left
out, an optional property or a union with options lacking it, type the verifier's credential as
that scheme's or Bearer's, as at run time; an explicit type argument naming a scheme requires
the options argument. `error` is what the verifier may fail with besides a refusal, such as
its issuer being unreachable: one schema, or a list, held as a list, refused where it encodes with
a built-in error's `_tag`. A misspelled option is a type error. A descriptor's public fields are
`name`, `identity`, `security` and `error`; its `~` keys are the library's own wiring, which no
host composes.

`verify` is the verifier itself, or a builder of it, like the one `Action.implement` takes
([Action.md](Action.md#implementations)): an Effect that yields startup services, such as a token
verifier, and returns the verifier, run once per layer graph.

A verifier receives the credential the descriptor's native scheme decodes, a `Redacted<string>`
token or key, or Basic's `{ username, password }`, and succeeds with the identity, or fails with
`Action.Unauthenticated`, `Action.Forbidden`, or an error its descriptor declares in `error`. A
missing or empty credential is refused before it runs. It reads the request the router provides;
another service it reads per request comes from router middleware provided after the
authentication.

`options.protectedResource`, for a Bearer descriptor only, is an OAuth protected resource, which
the provider publishes and names in every challenge, or an Effect that builds one, or none, where
it is known only at startup: it runs with the verifier's build, once per layer graph, and the
provider's layer requires what it yields. Exported type: `ProtectedResource`.

`refusalResponse` takes `authentication`, the descriptor refusing, `protectedResource`, the one
given to `layer`, and `authorization`, the request's `Authorization` header. Under a descriptor of
another scheme it answers as that descriptor's routes do: the JSON and status, `no-store`, a 401
naming that scheme, `Basic realm="<name>"` or the `Http` scheme, none for an API key, and no step-up
challenge. Left out, or a Bearer descriptor, it answers as Bearer's. It also takes an error
`authentication` declares, answered as the routes answer it. Exported type:
`RefusalResponseOptions`.

| Protected resource option | Meaning                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `resource`                | Required exact OAuth resource identifier; its path selects the discovery path.                |
| `authorizationServers`    | Required, nonempty: where clients get tokens.                                                 |
| `scopesSupported`         | Optional: every scope the resource accepts, published in discovery.                           |
| `scopesRequired`          | Optional, nonempty OAuth scope tokens: every 401 names them, and a first login requests them. |
| `resourceName`            | Optional human-readable name.                                                                 |

## Canonical

The example app's authentication, in two modules. The binding, which servers and clients import,
names the descriptor, `Login`, beside its actions ([ActionHttp.md](ActionHttp.md#canonical)):

```ts example=binding.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { CurrentActor } from "./authorization.js";
import { Double, GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";

// Browser-safe: how a remote caller proves it is CurrentActor, a bearer token unless
// `security` names another native scheme. The verifier lives in authentication.ts. The literal
// name identifies the verifier that may provide it.
export const Login = Authentication.make("example.Login", CurrentActor);

// Protected contracts get native bearer security (enforced and documented); `status`,
// declared `caller: Action.Anyone`, gets none.
export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI], {
  authentication: Login,
});
```

The server provides `Login`'s verifier, `authenticate`, to every layer serving protected
actions ([ActionHttp.md](ActionHttp.md#serving), [ActionMcp.md](ActionMcp.md#canonical)). It
answers a missing or unknown token with the built-in 401 and publishes the resource's discovery.

```ts example=authentication.ts
import { Effect, Redacted } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { type Actor, actors } from "./authorization.js";
import { Login } from "./binding.js";

// DEMO ONLY: a token is an actor's name. Verify real tokens with your authorization
// server's library instead, their audience included: issued for this resource.
const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

// Each request's token, as the native `HttpApiSecurity.bearer` decodes it, to its actor. A
// missing or empty token never reaches it; an unknown one is the built-in `Unauthenticated`,
// a 401 every client decodes, as is a missing one.
export const verify = (
  token: Redacted.Redacted<string>,
): Effect.Effect<Actor, Action.Unauthenticated> => {
  const name = Redacted.value(token);

  return isActorToken(name)
    ? Effect.succeed(actors[name])
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
};

// As an OAuth protected resource, it publishes RFC 9728 discovery, public, and every challenge
// names it, so an MCP client that was refused finds the server issuing its tokens. A first
// login requests read only; a write refused for its scope steps up.
export const protectedResource = {
  resource: "http://localhost:3000/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["users:read", "users:write"],
  scopesRequired: ["users:read"],
} satisfies Authentication.ProtectedResource;

// Server-only: `Login`'s verifier, provided to every layer serving protected actions. An
// Effect building it instead yields startup services, such as a token verifier, as a handler
// builder does; this demo needs none.
export const authenticate = Authentication.layer(Login, verify, {
  protectedResource,
});
```

### Outer and inner middleware

A host serving tenants on their own subdomains: a verifier built once at startup; each request's
tenant from native router middleware, provided after the authentication, which the verifier
reads per request; and endpoint middleware reading the identity, the HTTP layer's `middleware`,
which runs inside the authentication.

```ts example=authentication-tenant.ts
import { Context, Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { type Actor, actors, CurrentActor } from "./authorization.js";
import { Http, Login } from "./binding.js";
import { userActions } from "./handlers.js";

/** Each request's tenant: the first label of its host, `acme` for acme.example.com. */
export class Tenant extends Context.Service<Tenant, string>()("example/Tenant") {}

// Outer: native router middleware, providing what the verifier reads per request.
const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.provideService(route, Tenant, request.headers.host?.split(".")[0] ?? ""),
  ),
);

// Inner: reads the identity, so it is native endpoint middleware, which the layer runs inside
// the authentication of every route it serves, all of them protected.
export class LogCaller extends HttpApiMiddleware.Service<LogCaller, { requires: CurrentActor }>()(
  "example/LogCaller",
) {}

const LogCallerLive = Layer.succeed(LogCaller, (route) =>
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
const authenticate = Authentication.layer(
  Login,
  Effect.gen(function* () {
    const verifier = yield* Verifier;

    return (token: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const actor = yield* verifier.verify(token);

        if (actor.tenantId !== (yield* Tenant)) {
          return yield* new Action.Forbidden({ message: "Not a member of this tenant." });
        }

        return actor;
      });
  }),
);

// Provided in order: each `Layer.provide` gives what the layers before it still owe, so
// `resolveTenant`, last, gives the Tenant the verifier reads per request. One array,
// `Layer.provide([authenticate, resolveTenant.layer])`, would leave it owed: an array's
// members provide to the routes, not to one another.
export const routes = ActionHttp.layer(Http, userActions, { middleware: [LogCaller] }).pipe(
  Layer.provide([authenticate, LogCallerLive]),
  Layer.provide(Verifier.layer),
  Layer.provide(resolveTenant.layer),
);
```

### A scheme other than Bearer

A descriptor naming another native scheme, here a session cookie, gives its verifier the
credential that scheme decodes. Nothing steps up under it, and it publishes no protected
resource.

```ts
export const SessionLogin = Authentication.make("example.SessionLogin", CurrentActor, {
  security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }),
});

export const authenticateSession = Authentication.layer(
  SessionLogin,
  Effect.map(
    Sessions,
    (sessions) => (session: Redacted.Redacted<string>) => sessions.actorOf(Redacted.value(session)),
  ),
);
```

### A route of your own

A descriptor covers action endpoints alone. A route of the host's own beside them, such as an
export, a page frame or a WebSocket upgrade, takes `protect(descriptor)`, native router
middleware: the descriptor's provider verifies the request and gives the route the identity,
and the route is answered as an action's, its refusals, challenges and caching included. Its
own rule, such as a scope, fails with a refusal.

```ts example=authentication-route.ts
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { CurrentActor } from "./authorization.js";
import { Login } from "./binding.js";

// A route of the host's own beside the actions, authenticated as they are: the binding's
// descriptor's provider verifies the request and gives the route the actor. A refusal it
// fails with is answered as an action's, and a scope a caller lacks steps up under Bearer.
export const exportRoute = HttpRouter.add(
  "GET",
  "/export",
  Effect.gen(function* () {
    const actor = yield* CurrentActor;

    if (!actor.permissions.includes("users:read")) {
      return yield* new Action.Forbidden({
        message: "Requires users:read.",
        scopes: ["users:read"],
      });
    }

    return HttpServerResponse.text(`Users of ${actor.tenantId}.`);
  }),
).pipe(Layer.provide(Authentication.protect(Login).layer));
```

### Outside the router

A caller the router never routes, such as a Node `upgrade` handler admitting a socket,
authenticates its own header and refuses with `refusalResponse`: the response authentication
answers the same refusal with on a route.

```ts example=authentication-upgrade.ts
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { protectedResource, verify } from "./authentication.js";
import type { Actor } from "./authorization.js";

// A caller the router never routes, such as a Node `upgrade` handler admitting a socket,
// which authenticates the `Authorization` header itself: read as a route's is, with
// `bearerTokenOf`, and verified by the routes' own `verify`. A socket writes, so it needs the
// write scope. It gives the actor, or the response to refuse with, the one authentication
// answers the same refusal with on a route.
export const admit = (authorization: string | undefined): Effect.Effect<Actor, Response> =>
  Effect.fromOption(
    Authentication.bearerTokenOf(authorization),
    () => new Action.Unauthenticated(),
  ).pipe(
    Effect.flatMap(verify),
    Effect.filterOrFail(
      (actor) => actor.permissions.includes("users:write"),
      () => new Action.Forbidden({ message: "Requires users:write.", scopes: ["users:write"] }),
    ),
    Effect.mapError((error) =>
      HttpServerResponse.toWeb(
        Authentication.refusalResponse(error, { protectedResource, authorization }),
      ),
    ),
  );
```

## Rules

- `make` is browser-safe and declares no verifier: the binding imports it, and so does every client of the binding. Keep `layer`, and what its verifier imports, in server-only modules.
- One descriptor per identity and resource. Its name literal is its type identity: a layer serving protected actions requires `Provider<CurrentActor, "example.Login">`, which only `layer(Login, ...)` provides. A provider of another descriptor, even of the same identity, does not satisfy it. Reuse one name only for one declaration.
- The name is also its scheme's OpenAPI component key, as it is, so it holds only letters, digits, `_`, `.` and `-`: `example.Login`, not `example/Login`. `make` throws for any other.
- A descriptor names one native `HttpApiSecurity` scheme, decoded as Effect decodes it: `HttpApiSecurity.bearer` by default, for a credential sent as `Authorization: Bearer`, such as an OAuth access token; or another, such as `HttpApiSecurity.apiKey({ in: "cookie", key: "session" })` for a browser session, an API key in a header or the query, or `HttpApiSecurity.basic`. A record of schemes, or anything that is no native scheme, is refused by the types, and throws `Authentication takes one native HttpApiSecurity scheme`. There is no fallback between schemes: a host accepting two credentials serves them on two bindings or endpoints, each naming its own descriptor.
- OAuth is Bearer's: only a Bearer descriptor's provider takes a `protectedResource`, which the types refuse for another scheme and `layer` throws for, and only under a Bearer descriptor does a protected action's refusal step up ([guarantees.md](guarantees.md#authorization)); a public route's or a public tool's never does, signed in or not. Under another scheme, a refusal over HTTP is its JSON and status, with no `insufficient_scope` challenge, and over MCP a tool's refusal, from the authorizer or a handler, is an `isError` tool result, as on an endpoint without authentication; the authentication's own refusal is still its 401 or 403. Its 401 carries the challenge its scheme has: an `Http` scheme names itself, such as `Token`; Basic sends `Basic realm="<descriptor name>"`, quoted and escaped; an API key sends none. Responses keep `Cache-Control: no-store`.
- Basic's credential counts as presented when its user-id or its password is non-empty, so a token sent as the password, `Basic base64(":token")`, reaches the verifier. A cookie-authenticated browser client sends its cookie itself; whether a cross-origin page may is the host's CORS policy ([ActionHttp.md](ActionHttp.md#rules)).
- A binding holding a protected action names its descriptor, `ActionHttp.make(actions, { authentication: Login })`, and so does an MCP endpoint serving one, `ActionMcp.layerHttp(apps, { authentication: Login })`: required, and a descriptor of another identity is refused, in the types and when called. One identity per binding or endpoint: every protected action it holds declares the descriptor's.
- The descriptor both enforces and documents. Each protected endpoint of a binding carries Effect's native security middleware for it, which `OpenApi.fromApi`, Swagger and Scalar show as the operation's `security`, `[{ "example.Login": [] }]`, and in `components.securitySchemes`, keyed by the descriptor's name: distinct descriptors have distinct names, so their schemes never share a key in one combined document; a public endpoint states `security: []`. Clients are unchanged: they send whatever credential `transformClient` adds.
- Every HTTP or MCP layer serving a protected action requires the provider: `Layer.provide(authenticate)`. Give each the same `layer` value: it is built once per layer graph, however many layers it is provided to, and publishes discovery once. A layer serving only public actions requires none.
- Authentication runs before decoding: a protected request without a credential that verifies is refused before its body is read ([guarantees.md](guarantees.md#authorization)).
- The verifier succeeds with the identity value, fails with a refusal, or fails with an error its descriptor declares. `Unauthenticated` is sent as its JSON with **401**; `Forbidden` as its JSON with **403**. Both are the bodies every endpoint declares, so typed clients decode them. A declared error is sent as its JSON with its `httpApiStatus`, or 422 without one, as every protected endpoint of a binding naming the descriptor declares it, so `ActionHttp.client` and a remote CLI command decode it as a typed failure; a public endpoint, which nothing verifies, does not declare it. A route, an MCP endpoint and `protect` send it alike, `no-store`, and challenge it only as a 401. It can fail with nothing else: any other error is a type error, and in plain JavaScript a defect, an empty 500.
- A failure that is not the caller's, such as an issuer the verifier cannot reach, is a declared error, `error: ProviderUnavailable` with `httpApiStatus: 503`, not a refusal: an `Unauthenticated` would have the caller sign in again, which cannot help. Over MCP it is the endpoint's HTTP answer, before any tool runs, not a tool result: `Testing.mcpClient` fails with an `McpCallError` naming its status and body.
- It provides the identity to protected routes alone. A public route never gets it, beside protected ones in one layer too, and over HTTP ignores any credential the request carries. A public tool's call on an MCP endpoint naming a descriptor is verified when it presents a credential, refused with 401 when that does not verify, as MCP authorization requires of an invalid or expired token, and passes without one, or with one its scheme decodes as empty, such as `Authorization: Bearer` alone; the tool still gets no identity.
- Nothing else provides a protected action's identity remotely: neither a value provided at startup, around the server or the program, nor `HttpRouter.provideRequest`, nor other router middleware satisfies a layer serving it, which requires the provider ([guarantees.md](guarantees.md#authorization)).
- Every response to a request it authenticates gets `Cache-Control: no-store` unless its route states its own caching, and every 401 among them its scheme's challenge: [guarantees.md](guarantees.md#wire-behavior).
- A Bearer descriptor's 401 challenge is `Bearer`, or as a protected resource `Bearer scope="<scopesRequired>", resource_metadata="<metadata URL>"`, `scope` only when `scopesRequired` is given.
- A 401 to a request that presented a bearer token also names `error="invalid_token"` first (RFC 6750), whoever refused it: the token did not authenticate it, and a client may refresh it before it signs in again. A malformed token, such as `Bearer a b`, is a presented one (RFC 6750 §3.1). A request without one, or with another scheme such as `Basic`, gets no error code.
- An MCP client requests the scopes a 401 names, or every one of `scopesSupported` when it names none. Give `scopesRequired` whenever some scopes are needed only by some actions, so a first login asks for the least, and a `Forbidden` naming scopes asks for more when a call needs them.
- Step-up refusals follow [guarantees.md](guarantees.md#authorization), including the MCP exception when a notification has already started the **200** stream: a later refusal is an `isError` tool result without an HTTP challenge.
- When a `Forbidden` naming `scopes` is sent as an HTTP refusal under a Bearer descriptor, its **403** carries `WWW-Authenticate: Bearer error="insufficient_scope", scope="<scopes>"`. As a protected resource it adds `resource_metadata`, and `error_description` when the message is a valid one (printable ASCII without `"` or `\`).
- An OAuth client re-authorizes on that challenge with those scopes added, as MCP authorization requires; the official MCP client does. A `Forbidden` naming no scope has no challenge ([guarantees.md](guarantees.md#authorization)).
- Name scopes only when re-authorizing can grant them. A caller whose credential cannot step up, such as an API key, gets a `Forbidden` naming none: a plain 403, and a tool result over MCP, rather than a login prompt that cannot help.
- The descriptor covers actions alone. A route of the host's own, such as a WebSocket upgrade route, `RpcServer.layerProtocolWebsocket`'s, takes `protect(descriptor)`, native router middleware provided to it, `route.pipe(Layer.provide(Authentication.protect(Login).layer))`, which requires the descriptor's provider ([A route of your own](#a-route-of-your-own)). The credential the descriptor's scheme decodes is verified by the provider's verifier, and the route is given the identity. It is answered as an action's route: without a credential that verifies, with the refusal and challenge, or the error the verifier declares; its responses are marked and challenged as an action route's ([guarantees.md](guarantees.md#wire-behavior)). A refusal the route fails with is answered as an action's: `Unauthenticated` as 401, and `Forbidden` as 403, naming its `scopes` in an `insufficient_scope` challenge under Bearer, so an OAuth client steps up. `.combine` puts middleware reading the identity inside it.
- A caller the router never routes, such as a Node `upgrade` handler, verifies its own credential and answers a refusal with `refusalResponse(error, { protectedResource, authorization })`: the status, JSON, `Cache-Control: no-store` and challenge authentication answers that refusal with, by the rules above, `invalid_token` when `authorization` presented a bearer token. An error the descriptor declares takes the descriptor too, `refusalResponse(error, { authentication: Login, protectedResource, authorization })`, and is answered as its routes answer it. Give it the `protectedResource` given to `layer`, or its challenges name no metadata URL and no `scopesRequired`. It is an `HttpServerResponse`; `HttpServerResponse.toWeb` gives a web `Response`. It refuses, by throwing, the resource `layer` refuses: one under a descriptor of another scheme, an invalid `scopesRequired`, or a `resource` with a fragment.
- Such a caller reads its header with `bearerTokenOf(authorization)`, an `Option` of the `Redacted` token: the reading every challenge is decided by and a Bearer descriptor's verifier receives, as Effect's `HttpApiSecurity.bearer` decodes a request's header. Whitespace around the header value is no part of it, as an HTTP parser strips it before a route reads it; then `Bearer`, matched case-insensitively, one or more spaces, and the rest of the header is the token, a malformed one such as `a b` too. No scheme, another scheme, or nothing after the scheme is none.
- Verify that a token was issued for this resource, its audience `resource`, as MCP authorization requires (RFC 8707): one issued for another resource fails with `Unauthenticated`, as any token that does not verify. `layer` publishes `resource` in its discovery, but reads no token.
- An Effect building the verifier runs when the provider's layer is built, once per layer graph however many layers it is provided to, as a handler builder does ([guarantees.md](guarantees.md#dependency-lifetimes)). The services it yields are startup requirements of that layer: `Authentication.layer(Login, build).pipe(Layer.provide(Verifier.layer))`, or provided after it, `routes.pipe(Layer.provide(authenticate), Layer.provide(Verifier.layer))`. A resource it acquires lives as long as the layer; its failure fails the layer, so the server does not start. A verifier needing no startup service is passed as it is, `Authentication.layer(Login, verify)`.
- The services a verifier yields per request, beyond what the router provides, such as the request and its scope, are request requirements, as a handler's are. Native router middleware provides them, provided after the authentication, each in a `Layer.provide` of its own: `routes.pipe(Layer.provide(authenticate), Layer.provide(resolveTenant.layer))`. One array, `Layer.provide([authenticate, resolveTenant.layer])`, gives both to the routes and neither to the other, so the verifier's request requirement stays owed ([Failure modes](#failure-modes)). A startup service, such as a verifier, is yielded by the Effect building the verifier instead, never per request.
- Middleware reading the identity is the HTTP layer's own: `ActionHttp.layer(Http, apps, { middleware: [LogCaller] })`, native `HttpApiMiddleware` that runs inside the authentication of a protected route and before decoding ([ActionHttp.md](ActionHttp.md#rules)). One requiring the identity takes a layer whose `actions` lists only protected ones. An MCP endpoint has none.
- Router middleware provided around the routes runs before their authentication. Middleware that must also cover discovery and unrouted requests, such as a Host or Origin check, or one setting security headers on every answer, is global middleware, `HttpRouter.middleware(check, { global: true })`, merged beside the routes: it runs before routing. Merged before the routes, it also runs before the discovery `layer` publishes.
- A local surface has no remote caller: the host provides the identity service itself, as `Effect.provideService(CurrentActor, actor)`, or on a CLI command, `Command.provideSync(CurrentActor, actor)`. `authorize` still runs. An identity only a host supplies, such as an admin CLI's operator, is typed apart from what a verifier returns, so no token names it ([ActionCli.md](ActionCli.md#trusted-callers)).
- Resources a verifier acquires in the request scope live until that scope closes, including while the handler runs.
- Downstream action errors are handled by their transport. They are never serialized as authentication failures.
- Never provide `CurrentActor` or any identity or tenant tag in a startup layer or root context: [guarantees.md](guarantees.md#dependency-lifetimes).
- A resource read from configuration or a service is given as an Effect: `Authentication.layer(Login, verify, { protectedResource: Effect.map(Settings, ({ resource }) => resource) })`. Succeeding with `undefined` publishes nothing and challenges with a bare `Bearer`.
- A protected resource's discovery is published when the provider's layer is built, once per layer graph, however many layers it is provided to, and needs no route of its own. It publishes what it is given: the deployment must ensure `resource` and `authorizationServers` are valid OAuth URLs (HTTPS, or loopback HTTP in development).
- Discovery is served at `/.well-known/oauth-protected-resource` followed by the resource's path (`/.well-known/oauth-protected-resource/mcp` for `https://host/mcp`), for `GET` and `HEAD`, matching that literal path and query, and answers the CORS preflight there. It answers before routing, so no route middleware, authentication included, covers it. Other requests fall through to the host router. Caching policy is the host's.
- Any origin may read discovery, as a browser MCP client must after a 401: it carries `Access-Control-Allow-Origin: *`, and answers an `OPTIONS` preflight at its URL with **204**, allowing `GET`, `HEAD` and `OPTIONS` and the headers the preflight asks for. Where the host's CORS middleware runs before it, that policy answers discovery's preflight and adds its headers to discovery's reads, so an origin it allows may read discovery, and discovery keeps its `*` where the policy sets no origin. Global middleware runs in the order it registers while layers build, which is the order it is merged in unless something built before it is asynchronous; either way, an origin the host's policy allows may read discovery.
- A host with two resources makes one descriptor and one `layer` per resource; a cookie-authenticated dashboard beside them takes a descriptor of its own, on a binding of its own.
- Tool discovery is never filtered by actor. Action-level authorization belongs in the implementation's `authorize`, which runs with the action contract in hand; write the rule against `action.readOnly` rather than repeating a check in each handler. Record-level checks follow [guarantees.md](guarantees.md#authorization).

## Failure modes

- `Provider<CurrentActor, "example.Login">` among a layer's requirements, `Type 'Provider<...>' is not assignable to type 'never'` where the server is launched, at `Layer.launch` or `NodeRuntime.runMain`, or `Expected 2 arguments, but got 1` at a web handler's `handler(request)`: a layer serves protected actions, and no provider of the binding's or endpoint's descriptor is provided to it. Provide it, `Layer.provide(authenticate)`. A value of the identity provided at startup, around `HttpRouter.serve` or the program, or per request with `HttpRouter.provideRequest`, does not satisfy it, by design. Where the routes require no provider, `Expected 2 arguments` at `handler(request)` means their platform services are not provided instead ([Testing.md](Testing.md#failure-modes)).
- `Provider<CurrentActor, "example.Login">` still owed although a `layer` is provided: it is a provider of another descriptor, of the same identity or not. Provide the provider of the descriptor the binding or endpoint names.
- `No overload matches this call` at `ActionHttp.make`, its last overload naming `"Protected actions take options naming their authentication"`, or a type error naming `authentication` there or at `ActionMcp.layerHttp`: the binding or endpoint serves a protected action and names no descriptor. Give `{ authentication: Login }`. `"Authentication descriptor does not cover every protected action"` instead: the descriptor's identity is not the one the protected actions declare.
- `Protected action '<name>' requires its matching authentication descriptor` thrown by `ActionHttp.make`, `ActionHttp.layer` or `ActionMcp.layerHttp`: plain JavaScript gave no descriptor, or one of another identity. Give the descriptor of the identity the action declares.
- A type error on `security` at `make`, or `Authentication takes one native HttpApiSecurity scheme` thrown by `make`: `security` is a record of schemes, or no native scheme at all. Omit it for Bearer, or give one scheme, `HttpApiSecurity.apiKey({ in: "cookie", key: "session" })`.
- A type error on `protectedResource` at `layer`, or `A protected resource is published only for a Bearer scheme` thrown by `layer` or `refusalResponse`: the descriptor names another scheme, which OAuth discovery and challenges do not speak. Drop the resource, or authenticate with a Bearer descriptor.
- `Invalid authentication name: "<name>", not an OpenAPI key` thrown by `make`: the name holds a character an OpenAPI component key cannot, such as `/` or `:`. Use letters, digits, `_`, `.` and `-`: `example.Login`.
- `Missing verify: pass a verify function, or an Effect building one`, a defect when the provider's layer builds: `layer` was given neither a function nor an Effect building one, as plain JavaScript may pass. Pass `verify` itself.
- `Request<"Requires", Tenant>` still owed although the tenant middleware's layer is provided: it was provided in one array with the authentication, `Layer.provide([authenticate, resolveTenant.layer])`, whose members provide to the routes and not to one another. Provide it in a later `Layer.provide` of its own ([Rules](#rules)).
- An action that must be authenticated answers without credentials: its contract states `caller: Action.Anyone`. Make it protected; the surfaces then authenticate it, whatever its handler reads.
- A public tool's call answers 401 on an MCP endpoint serving protected tools too: it presented a credential that does not verify, such as an expired token, and the endpoint verifies a presented credential. Send a valid one, or none.
- An MCP host asks for sign-in when it connects: every tool of the endpoint is protected, so every request authenticates. One serving public tools too lists its tools and runs the public ones without signing in, and a protected tool's call answers the 401 the host signs in on; whether a host signs in then, rather than reporting the error, is the host's.
- Type error at `layer` on `verify`: a verifier fails with an error that is neither a refusal nor one its descriptor declares, or succeeds with a value that is not the identity. Declare the error in the descriptor's `error`, or map it to a refusal where it is the caller's, and return the identity's type.
- `Authentication "<name>": error _tag "<tag>" is built in, and declared on every surface` thrown by `make`: an `error` entry encodes with the `_tag` of `InvalidInput`, `Unauthenticated` or `Forbidden`. Fail with the built-in refusal itself, which needs no declaring, or give the error a `_tag` of its own.
- A verifier's declared error arrives as 422, which a client reads as its request being wrong: the error states no `httpApiStatus`, and a declared error without one is sent as 422, as an action's is. Give it the status it means, such as `{ httpApiStatus: 503 }` for an issuer the verifier cannot reach.
- `Not a refusal, nor an error the authentication declares` thrown by `refusalResponse`: the error is neither, or the descriptor declaring it was not given. Pass `authentication`.
- `Verifier` unsatisfied at startup: the Effect building the verifier yields it. Provide it to the provider's layer, `Authentication.layer(Login, build).pipe(Layer.provide(Verifier.layer))`, or above it.
- A request the Host or Origin check should refuse gets a 401 and a challenge: the check is the HTTP layer's `middleware`, which runs inside the authentication. Make it router middleware around the routes, or global middleware, merged beside the routes, to cover discovery too ([Rules](#rules)).
- Discovery returns 404: the request path does not match `resource`'s path and query exactly, or the provider is provided to no served layer.
- An MCP client does not find the authorization server: discovery is not at the well-known URL for the endpoint's path. Set `resource` to the endpoint's exact URL.
- An MCP client reports `InsufficientScopeError` instead of re-authorizing: it has no OAuth provider configured, so it cannot step up. Configure one, or grant the scope up front.
- `new Action.Forbidden({ scopes })` throws a schema validation error: a scope is not an OAuth scope token (it is empty, or contains a space, `"` or `\`). Give each scope as its own element.
- An MCP client asks a user who only reads to consent to writes on first login: the 401 names no scope, so it requests every one of `scopesSupported`. Give `scopesRequired`.
- `Invalid scope in scopesRequired: "<scope>"` thrown by `layer` or `refusalResponse`, or for a built resource a defect when its layer builds: a scope is empty or contains a space, `"` or `\`. Give each scope as its own element.
- `A protected resource has no fragment: <resource>` thrown by `layer` or `refusalResponse`, or for a built resource a defect when its layer builds: `resource` has a `#fragment`, which no request URL carries, so its discovery would never answer (RFC 9728). Drop the fragment.
- A route's `Cache-Control` is replaced by `no-store`: an enclosing middleware serialized the response of a failure. Only a route's own answer keeps its caching.
