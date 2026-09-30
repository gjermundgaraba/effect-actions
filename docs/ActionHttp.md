# ActionHttp

JSON `POST` routes on Effect's `HttpApi`. `ActionHttp.make` binds actions to a mount path; the
binding is shared by the server, every client, and the OpenAPI document. Servers mount it with
`ActionHttp.layer(Http, implementations)`, serving the binding's actions among the
implementations, each behind its implementation's hook, under whatever middleware the host
provides around it, authentication included; clients call it with `ActionHttp.client(Http)`.

## API

Import `@gjermundgaraba/effect-actions/ActionHttp`.

| API                            | Purpose                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `make(actions, options?)`      | Bind a list of actions; returns a `Binding`.                                                 |
| `Http.actions`                 | The exact bound actions.                                                                     |
| `Http.errors`                  | The errors every endpoint declares besides its action's own.                                 |
| `Http.api`                     | Native Effect `HttpApi` for clients and OpenAPI.                                             |
| `layer(Http, implementations)` | Mount the routes of the bound actions these implementations hold, behind their hooks.        |
| `client(Http, options?)`       | An Effect of a typed client; requires the native `HttpClient`, as `HttpApiClient.make` does. |

Exported types: `Binding`; `Any`, any binding; `Client`, a client's type: `Client<typeof Http>`; `Options` of `make` and `ClientOptions` of `client`.

| Option                      | Meaning                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `make`: `prefix`            | Mount path of every route; defaults to `/api`. `/` mounts at the root; a trailing slash is dropped.                             |
| `make`: `errors`            | Errors middleware around the routes sends, such as a limit before decoding: declared by every endpoint, so clients decode them. |
| `make`: `security`          | Documentation only: the credentials the authentication around the routes reads, `{ bearer: HttpApiSecurity.bearer }`.           |
| `make`: `public`            | The binding's actions served without authentication: their endpoints state no security.                                         |
| `client`: `baseUrl`         | What routes are resolved against, such as `https://api.example.com`. Omitted: relative routes (the page's origin in a browser). |
| `client`: `transformClient` | Wraps the native `HttpClient`. A bearer token: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.                   |

Routes: each action is served at `POST <prefix>/<action>`, operation ID `<action>`. The
OpenAPI tag is the mount path's segments (`api`, `v2/api`), or `/` at the root. Every
endpoint declares its action's errors, the binding's `errors`, and the built-in
`InvalidInput` (400), `Unauthenticated` (401) and `Forbidden` (403).

Layer failures and startup requirements come from the builders of the supplied
implementations. The request services of each implementation's hook, and of the handlers of
the actions the layer serves, remain router request requirements until middleware provided
around the layer, such as authentication, provides them; an action the binding leaves out owes
nothing there. Router/platform services are also required
([guarantees.md](guarantees.md#dependency-lifetimes)).

## Canonical

The binding, shared by the server and every client:

```ts
import { HttpApiSecurity } from "effect/http-api";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Double, GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";

// Contract-level: the server and its clients share it, and it is plain data. Every
// endpoint also declares the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`,
// so a typed client decodes a malformed request, the authentication's 401 and the
// authorization hook's 403 instead of reporting a decode error. `ListChanges` is a tool
// for agents reviewing what happened, so HTTP leaves it out.
export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI], {
  // For the OpenAPI document: the credential the authentication around the routes reads,
  // stated on every endpoint but the public `status`'s. It enforces nothing: the
  // authentication provided around a layer does.
  security: { bearer: HttpApiSecurity.bearer },
  public: [Status],
});
```

### Serving

```ts
import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiSwagger, OpenApi } from "effect/http-api";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { authenticate } from "./authentication.js";
import { Http } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

// One binding, two layers: authentication covers the routes of the layer it is provided
// to, so `status` stays public while the others authenticate. Each layer serves the
// binding's actions its implementations hold, so the public one is given only
// implementations of public actions.
const routes = Layer.mergeAll(
  ActionHttp.layer(Http, status),
  ActionHttp.layer(Http, [userActions, double]).pipe(Layer.provide(authenticate)),
);

// `Http.api` is a native HttpApi, so documents are Effect's own: the OpenAPI JSON at
// `GET /api/openapi.json`, and a Swagger UI reading the same contract, its bearer scheme
// included.
const documentation = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/api/openapi.json",
    HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)),
  ),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
);

export const layer = Layer.mergeAll(routes, documentation);
```

Serve with `HttpRouter.serve(layer).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })), Layer.launch)`, and set a request body limit ([guarantees.md](guarantees.md#wire-behavior)).

A large API, or two actions that would share a name, gets one binding per area, each with its
own `prefix` and client, served by one host:

```ts
export const Billing = ActionHttp.make([Invoice, Refund], { prefix: "/api/billing" });
export const Accounts = ActionHttp.make([GetUser, RenameUser], { prefix: "/api/accounts" });

const routes = Layer.mergeAll(
  ActionHttp.layer(Billing, billing),
  ActionHttp.layer(Accounts, accounts),
);

// One document for both, when no action name repeats across them:
// HttpApi.make("app").addHttpApi(Billing.api).addHttpApi(Accounts.api)
```

### Client

`client(Http)` is Effect's native `HttpApiClient` with one method per action, taking the
action's input directly and answering with its decoded success: `client.<action>(input)`.

```ts
import { Console, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./binding.js";

const lookup = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, {
    baseUrl: "http://127.0.0.1:3000",
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
  });

  const status = yield* client.status();
  const user = yield* client.getUser({ id: "1" });
  const identity = yield* client.whoAmI();

  return { status, user, identity };
});

// Every endpoint declares the built-in refusals, so the 401 the authentication
// renders arrives as a typed `Unauthenticated`, not a decode error.
const refused = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, { baseUrl: "http://127.0.0.1:3000" });

  return yield* Effect.flip(client.whoAmI());
});

await Effect.runPromise(
  Effect.all([lookup, refused]).pipe(
    Effect.tap(Console.log),
    Effect.provide(FetchHttpClient.layer),
  ),
);
```

The argument may be omitted when `{}` is a valid input, such as for an action declared without
`input` (`client.whoAmI()`) or one whose fields are all optional, in a struct or a class;
omitting it sends the input `{}` decodes to. Other headers also go through `transformClient`
(`HttpClient.mapRequest(HttpClientRequest.setHeader("x-agent", agent))`). The options are the
native `HttpApiClient.make` options except `transformResponse`, which may change a call's
success, failure or required services, which the method types cannot follow; use
`transformClient`, or the native client.

### Promise callers

Code that does not run Effects, such as a browser app, builds the client once with its
`HttpClient` and runs each call with `Effect.runPromise`.

```ts
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./binding.js";

// Built once, for code that does not run Effects: its methods need nothing more.
export const api = ActionHttp.client(Http).pipe(
  Effect.provide(FetchHttpClient.layer),
  // `fetch` is read on every call, so a wrapper or a test's stub installed later is used.
  Effect.provideService(FetchHttpClient.Fetch, (input, init) => globalThis.fetch(input, init)),
  Effect.runSync,
);

// A promise per call. A declared error rejects it as its decoded value, so
// `error instanceof UserNotFound` holds in a `catch`.
export const userName = async (id: string): Promise<string> =>
  (await Effect.runPromise(api.getUser({ id }))).name;
```

A declared error rejects the promise as its decoded value, so `catch` code matches it with
`instanceof`. The native `FetchHttpClient` reads the default `fetch` once, on first use, so a
`fetch` installed later, such as a test's stub, is used only when `FetchHttpClient.Fetch`
reads it on each call, as above. In a browser, relative routes resolve against the page;
elsewhere, give `baseUrl`.

## Rules

- The binding decides what HTTP serves: the actions passed to `make`, and no others; an action has no HTTP switch. To keep an action off HTTP, leave it out of the list. Its implementation may still hold it for MCP, a Toolkit or `ActionCli.make`, which serve every action of the implementations they are given.
- Action names are unique within a binding. Two bindings with different prefixes may reuse a name and be served side by side, but not combined into one `HttpApi`.
- `layer(Http, implementations)` mounts the routes of the binding's actions among the implementations it receives, matched by identity: the exact contract values passed to `make`. Their other actions get no route, and their names are not checked. An implementation holding none of the binding's actions is refused, in the types and at runtime, as the wrong implementation or the wrong binding. An equal-looking copy of a bound action is not the bound action, so it is not served.
- An action may be served once per call; two implementations there may both hold an action the binding leaves out. An action no layer serves still appears in `Http.api`, OpenAPI and clients, and answers 404.
- The binding is plain data: `layer` and `client` read everything from its fields, so a copy of the binding, or one made by another installed copy of the package, serves the same.
- Middleware, authentication included, is per layer call: provided to a `layer` call, it covers that call's routes, before decoding, and no others. Public and authenticated actions go in separate `layer` calls over the same binding, merged with `Layer.mergeAll`; they still share one binding, one document and one client.
- **A layer without authentication is given only implementations of public actions.** Where one implementation holds public and protected actions, give each layer an `Action.share` of its own actions: `Action.share([Poll], users, Action.allowAll)` to the public layer, `Action.share([Write], users)` to the authenticated one. A layer serves every bound action its implementations hold: bind an action that a public layer's implementation also holds, and anyone may call it. The types catch this only where a handler or the hook reads an identity, which nothing then provides; under `Action.allowAll`, a handler reading none compiles. No type can tell a public layer from a protected one: authentication is router middleware, provided after `layer` returns.
- The hook, builders, request-time services and headers follow [guarantees.md](guarantees.md): `ActionHttp` itself sets no header.
- `Http.api` is a plain `HttpApi`. Anything Effect can do with an `HttpApi` works: `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`, `Http.api.addHttpApi(other)` to combine with other APIs, `HttpApiClient.make`. Serve it with `layer`: under `security`, its endpoints carry native security middleware, which `layer` leaves out and the native `HttpApiBuilder` requires.
- The endpoints are one top-level group named after the mount path, so the native client exposes them as `client.<action>({ payload })`.
- Bindings combine into one host API with the native `addHttpApi` method, `HttpApi.make("app").addHttpApi(Http.api)`, for one document or one native client, only when their prefixes differ and no action name repeats across them. An operation ID is the action name, and a group is keyed by its mount path. Serving several bindings with `layer` has neither limit.
- Serve the OpenAPI document as a native route: `HttpRouter.add("GET", "/api/openapi.json", HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)))`. It documents every bound action, not only the served ones. It is a plain route: middleware provided to its layer covers it, and nothing covers it otherwise.
- A route runs only a request typed as JSON: any other type, or none, is a 415, as on an MCP endpoint. So no request a page on another origin can send without a CORS preflight reaches a handler, whatever credentials, cookies included, it carries; one typed as JSON is preflighted, and the host's CORS policy decides.
- Wire format: [guarantees.md](guarantees.md#wire-behavior). Spans and log annotations: [guarantees.md](guarantees.md#observability).

### Binding errors

- `errors` are what middleware around the routes answers with, on any endpoint: `ActionHttp.make(actions, { errors: [RateLimited] })`. Every endpoint declares them, OpenAPI shows them, and every client decodes them.
- Middleware sends one as the binding declares it, at the status its `httpApiStatus` states, or 422 without one: for `class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {}, { httpApiStatus: 429 }) {}`, `HttpServerResponse.schemaJson(RateLimited)(error, { status: 429 })`. A union with its own `httpApiStatus` uses that status for every member; otherwise, each member of a plain union is declared at its own status, or 422 without one.
- No handler or hook fails with them: both serve every surface, and only HTTP declares them. An action whose handler fails with one lists it in its own `errors`; a limit its implementation's hook applies is listed by each of its actions ([guarantees.md](guarantees.md#authorization)).
- They may not reuse a built-in error's tag: `layer` refuses such a binding.

### Documented security

- `security` states in the OpenAPI document what the authentication around the routes reads: `ActionHttp.make(actions, { security: { bearer: HttpApiSecurity.bearer }, public: [Status] })`. The schemes are Effect's own, such as `HttpApiSecurity.bearer`, `apiKey({ key })` and `basic`. Every endpoint but a `public` action's lists each as a requirement, any one sufficing; `OpenApi.fromApi`, `HttpApiSwagger` and `HttpApiScalar` show them, and a combined document keeps each binding's.
- **A declared scheme enforces nothing**: it admits and refuses no one, and `layer` serves every endpoint without it. The authentication provided around a layer is the only enforcement ([Authentication.md](Authentication.md)). A route the document shows as protected is open in a layer without authentication, and a `public` action is refused in a layer with it.
- `public` names the binding's own actions; the types refuse any other. Keep it in step with the layers: an action left out of it is documented as protected, which only overstates; one listed but served behind authentication is documented as open.
- Clients read none of it: a client sends what `transformClient` adds, whatever the document says.

### Client methods

- A method fails with exactly what the native client fails with. Declared errors arrive as their decoded values: the action's own, the binding's, and the three built-in errors every endpoint declares. Match them with `Effect.catchTag`.
- Anything the contract does not account for is Effect's own error:
  - `HttpClientError` with `response` `undefined`: the server could not be reached.
  - `HttpClientError` with `reason._tag` `DecodeError`: the server answered with a status no schema declares, such as the empty 500 of a defect.
  - `HttpClientError` with `StatusCodeError`: a declared status whose body did not decode.
  - `SchemaError`: the input did not encode, or the success body did not decode.
- The library interprets no status. Which failures mean "signed out" or "try again" is the caller's decision.
- Nothing is retried. A failed write may or may not have happened; only a declared error says what the server did.
- Every action of the binding has a method, whether or not a server serves it. An unserved action answers 404 with no body, so its method fails with `HttpClientError`: `DecodeError`, or `StatusCodeError` when the action declares a 404 error, whose body the empty response is not.
- A given argument is sent as given: `null` or `undefined` is the input itself, for a schema that accepts it.
- The client holds no connections or timers. `client` builds the native client once from the `HttpClient` in context.
- The native client stays available: `HttpApiClient.make(Http.api)` has the same routes, with methods taking `{ payload }`.
- In a browser, import the binding from a module with no server code, so the bundle keeps the client alone ([setup.md](setup.md#browser)).
- In tests, provide `Testing.layer(routes)` instead of a network client; `baseUrl` may be left out ([Testing.md](Testing.md)). `Action.client` has the same methods in process, for what an implementation does without the wire ([Action.md](Action.md#clients)).

### Built-in errors

- Every endpoint declares the built-in errors ([guarantees.md](guarantees.md#wire-behavior)). `client`, a remote `ActionCli` command and the native `HttpApiClient` decode them as typed failures, and OpenAPI shows them on every operation. They cannot be left out; the binding's `errors` add to them.
- `InvalidInput`'s `message` is the schema's own description of every issue: `{"_tag":"InvalidInput","message":"Expected string\n  at [\"name\"]"}`.

## Failure modes

- Route returns 404: the action is not in the binding, its implementation was never passed to a `layer` call, or the path lacks the prefix. An implementation's action is served only if the binding holds that very value: an equal-looking copy, such as a test declaring the contract again, is not.
- Type error at `layer` naming `"serves no action of this binding": "x"`, or `No action of this implementation is in this HTTP binding: x` thrown by it: none of the implementation's actions was passed to this binding's `make`, so it is the wrong implementation or the wrong binding. `x (another contract)` is an action of a bound name that is not the bound value, as a second copy of the contracts module makes: implement the exact contract value the binding received. Matching names and schemas do not establish identity. Inside a helper, where the named actions are a type such as `Extract<ActionOf<Idle<App, …>>, Any>["name"]`, the helper lists its type parameter beside another implementation (`[app, double]`), or makes the binding or an `Action.share` from generic actions, so the check cannot read which actions they hold. Take the implementations as one type parameter and spread it, `ActionHttp.layer(Http, [...apps, double])`; take the binding as a type parameter, and pass a share in.
- `Duplicate served action: <name>`: one `layer` call received two implementations of the same bound action.
- `Duplicate error _tag in action "<name>" and its binding: <tag>` thrown by `layer`: an error of the action and one of the binding's `errors` share a `_tag`. Rename one, or list the one schema in both.
- `Method 'POST' already declared for route '<prefix>/<action>'` when the host builds: two `layer` calls serve the same action, such as one implementation given to both the public and the authenticated layer, or a share of it to one and the whole to the other. Serve each action in one call: give each layer an `Action.share` of its own actions, `Action.share([Poll], users, Action.allowAll)` to the public layer and `Action.share([Write], users)` to the authenticated one.
- `ActionHttp binding: error _tag "Forbidden" is built in, and declared on every surface` thrown by `layer`: a binding error has a built-in tag, or is a built-in error. Drop a built-in error, which every endpoint declares already; rename an error of your own.
- `Duplicate action: <name>` thrown by `make`: two actions share a name, or one action value is listed twice. Rename one, or bind it under another prefix.
- `Duplicate OpenAPI operationId: <name>` from `OpenApi.fromApi` on a combined API: two combined bindings have an action of that name. Rename one, or document each binding on its own.
- A combined document or native client lacks one binding's actions: two combined bindings share a prefix, so one group replaced the other. Give each its own prefix, or bind the actions together.
- Type error listing `HttpRouter.Request.From<"Requires", CurrentActor>` as unsatisfied: a handler or the hook yields a request service that no middleware around the layer provides. Provide the authentication around it, `layer.pipe(Layer.provide(authenticate))` ([Authentication.md](Authentication.md)), or other router middleware. On a layer meant to be public, an implementation holding a protected bound action is the cause: give each layer an `Action.share` of its own actions ([Rules](#rules)).
- A route answers without credentials: the layer serving it has no authentication, such as a public layer given the implementation holding its action beside public ones. Give each layer an `Action.share` of its own actions ([Rules](#rules)). Only the authentication around a layer enforces; `security` only documents it.
- Swagger shows no Authorize button, or shows a protected route as open: the binding declares no `security`, or lists the action in `public`.
- `Conflicting OpenAPI security scheme: <name>` from `OpenApi.fromApi` on a combined API: two combined bindings declare different schemes under one name. Declare the same scheme, or name them apart.
- `Action "x" is not in this HTTP binding` thrown by `make`: `public` names an action the binding does not hold, which only plain JavaScript can pass.
- `Service not found: effect-actions/ActionHttp/Security/…` when the host builds: `Http.api` of a binding with `security` is served with the native `HttpApiBuilder`. Serve it with `layer`.
- 400 `InvalidInput` on a valid-looking request: its `message` names each field that did not decode, or that the action does not declare, such as a misspelling. An action without input takes only `{}`, and a body.
- 415 `Unsupported content-type: <type>` (`none` when it has none): the request is not typed as JSON. It has another content type, such as `fetch`'s default `text/plain` for a string body, or none, as for a `Blob` body. Send `Content-Type: application/json`, as the clients do.
- Empty 500: a defect, or a handler result that does not match the success schema. The cause is in the server's logs.

### Client methods

- Fails with `HttpClientError` whose `reason._tag` is `DecodeError` for a status such as 429: the server answered with a status no schema declares. Declare that error on the binding, `make`'s `errors`, when middleware answers with it; on the action when its handler or its hook does; or handle the native error. The built-in 400, 401 and 403 always decode, as long as their body is the built-in error's JSON.
- Fails with `HttpClientError` whose `reason._tag` is `InvalidUrlError` outside a browser: `baseUrl` is omitted, and there is no page to resolve relative routes against. Set `baseUrl`.
- Type error listing `HttpClient` as an unsatisfied requirement of `client`: provide one, such as `FetchHttpClient.layer`.
- Property does not exist on the client: the action is not in the binding.
- `Expected 1 arguments`: `{}` is not a valid input for the action, so it needs its input.
- Type error passing `undefined` to a method whose argument may be omitted: leave the argument out instead.
- Fails with `SchemaError` `Expected Filters` given a plain object, which TypeScript may let through: the input is a class, `Filters`, which encodes only its instances. Pass `new Filters({ ... })`, or leave out an argument whose fields are all optional.
- Type error passing `{ payload: ... }`: that is the native client's shape. These methods take the input itself.
