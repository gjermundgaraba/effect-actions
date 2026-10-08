# ActionHttp

JSON `POST` routes on Effect's `HttpApi`. `ActionHttp.make` binds actions to a mount path and
names the authentication descriptor of its protected actions; the binding is shared by the
server, every client, and the OpenAPI document. Servers mount it with
`ActionHttp.layer(Http, implementations)`, serving the binding's actions among the
implementations, or those its `actions` lists: each protected route authenticated before its
body is read, then each call
behind its implementation's authorization. Clients call it with
`ActionHttp.client(Http)`.

## API

Import `@gjermundgaraba/effect-actions/ActionHttp`.

| API                                      | Purpose                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `make(actions, options?)`                | Bind a list of actions; returns a `Binding`. Options are required for a protected action.    |
| `Http.actions`                           | The exact bound actions.                                                                     |
| `Http.error`                             | The errors every endpoint declares besides its action's own.                                 |
| `Http.prefix`                            | Where the routes mount: `/api` by default, `/` at the root, without a trailing slash.        |
| `Http.authentication`                    | The authentication descriptor of its protected actions, or `undefined`.                      |
| `Http.api`                               | Native Effect `HttpApi` for clients and OpenAPI.                                             |
| `layer(Http, implementations, options?)` | Mount the routes of the bound actions these implementations hold, or the listed ones.        |
| `client(Http, options?)`                 | An Effect of a typed client; requires the native `HttpClient`, as `HttpApiClient.make` does. |
| `fetchClient(Http, options?)`            | The same client, built over `fetch` outside an Effect: its methods require nothing.          |

Exported types: `Binding`; `Any`, any binding; `Client`, a client's type: `Client<typeof Http>`; `MethodError`, what one of its calls fails with; `Options` of `make`, `LayerOptions` of `layer`, `ClientOptions` of `client` and `FetchClientOptions` of `fetchClient`.

| Option                      | Meaning                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `make`: `prefix`            | Mount path of every route; defaults to `/api`. `/` mounts at the root; a trailing slash is dropped.                               |
| `make`: `error`             | Errors middleware around the routes sends, such as a limit before decoding: declared by every endpoint, so clients decode them.   |
| `make`: `authentication`    | The descriptor of the protected actions' identity, `Authentication.make(...)`: required when the binding holds one.               |
| `layer`: `actions`          | The bound actions it serves, among the implementations': `[GetUser]`. Defaults to every one they hold.                            |
| `layer`: `middleware`       | Native `HttpApiMiddleware` run around every route the layer serves, inside authentication, outside decoding; the first innermost. |
| `client`: `baseUrl`         | What routes are resolved against, such as `https://api.example.com`. Omitted: relative routes (the page's origin in a browser).   |
| `client`: `transformClient` | Wraps the native `HttpClient`. A bearer token: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.                     |
| `fetchClient`: `fetch`      | What each call sends with; it also takes `client`'s options. Omitted: the global `fetch`, looked up on every call.                |

Routes: each action is served at `POST <prefix>/<action>`, operation ID `<action>`. A
read-only action is a `POST` too: `readOnly` changes neither the method nor caching. The
OpenAPI tag is the mount path's segments (`api`, `v2/api`), or `/` at the root. Every
endpoint declares its action's errors, the binding's `error`, and the built-in
`InvalidInput` (400), `Unauthenticated` (401) and `Forbidden` (403); a protected one also
declares its descriptor's `error`, what the verifier may fail with.

Layer failures and startup requirements come from the builders of the supplied
implementations, and, where it serves a protected action, the descriptor's provider,
`Authentication.layer`. The request services of each implementation's authorizer and of the
handlers of the actions the layer serves
remain router request requirements until middleware provided around the layer provides them,
the protected actions' identity excepted, which the provider supplies; an action the binding
leaves out owes nothing there. Router/platform services are also required
([guarantees.md](guarantees.md#dependency-lifetimes)).

## Canonical

The binding, shared by the server and every client, names the authentication descriptor of its
protected actions ([Authentication.md](Authentication.md#canonical)):

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

### Serving

One layer serves the public and the protected actions: each protected route authenticates
before its body is read, and `status` stays open.

```ts example=http.ts
import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiSwagger, OpenApi } from "effect/http-api";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { authenticate } from "./authentication.js";
import { Http } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

// One layer: each protected route authenticates before decoding; `status` stays public.
const routes = ActionHttp.layer(Http, [status, userActions, double]).pipe(
  Layer.provide(authenticate),
);

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

Serve with `HttpRouter.serve(layer).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })), Layer.launch)`, and set a request body limit ([guarantees.md](guarantees.md#wire-behavior)). Put a job or an agent the process runs inside `layer`, not beside `HttpRouter.serve`, so it shares the routes' builders and services rather than building its own ([dependency lifetimes](guarantees.md#dependency-lifetimes)).

A large API, or two actions that would share a name, gets one binding per area, each with its
own `prefix` and client, served by one host, and each documented on its own where they share a
name ([Failure modes](#failure-modes)):

```ts
export const Billing = ActionHttp.make([Invoice, Refund], { prefix: "/api/billing" });
export const Accounts = ActionHttp.make([GetUser, RenameUser], { prefix: "/api/accounts" });

// Each layer takes the whole list, and serves its binding's actions among it.
const routes = Layer.mergeAll(
  ActionHttp.layer(Billing, [billing, accounts]),
  ActionHttp.layer(Accounts, [billing, accounts]),
);

// One document for both, when no action name repeats across them:
// HttpApi.make("app").addHttpApi(Billing.api).addHttpApi(Accounts.api)
```

### Client

`client(Http)` is Effect's native `HttpApiClient` with one method per action, taking the
action's input directly and answering with its decoded success: `client.<action>(input)`.

```ts example=client.ts
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

The argument may be omitted when `{}` is a valid encoded input, such as for an action declared
without `input` (`client.whoAmI()`) or one whose fields are all optional or have a decoding
default, in a struct or a class; omitting it sends the input `{}` decodes to. Other headers also go through `transformClient`
(`HttpClient.mapRequest(HttpClientRequest.setHeader("x-agent", agent))`). The options are the
native `HttpApiClient.make` options except `transformResponse`, which may change a call's
success, failure or required services, which the method types cannot follow; use
`transformClient`, or the native client.

`transformClient` sees every response before the contract decodes it, so a status is read
there whatever its body: a page told that its session ended, by the contract's 401 or a
proxy's, with
`HttpClient.tap((response) => Effect.sync(() => { if (response.status === 401) signedOut(); }))`.
The call still fails as typed, with `Unauthenticated` or an `HttpClientError`.

### Promise callers

Code that holds a client outside an Effect, such as a browser app, builds it once with
`fetchClient(Http, options?)`: `client` over `fetch`, its methods the same Effects, requiring
nothing. Each call runs with `Effect.runPromise`.

```ts example=promise-client.ts
import { Effect } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./binding.js";

// Built once, outside any Effect: its methods need nothing more.
export const api = ActionHttp.fetchClient(Http);

// A promise per call. A declared error rejects it as its decoded value, so
// `error instanceof UserNotFound` holds in a `catch`.
export const userName = async (id: string): Promise<string> =>
  (await Effect.runPromise(api.getUser({ id }))).name;
```

A declared error rejects the promise as its decoded value, so `catch` code matches it with
`instanceof`. A call sends with the `fetch` option, such as one sending the page's cookies,
`(input, init) => fetch(input, { ...init, credentials: "include" })`; without it, with the
global `fetch` as the call finds it, so a test's stub installed after the client is built is
used. A `fetch` of your own keeps `init.signal`, which aborts the request when its call is
interrupted: a deadline is `Effect.timeout` on the call,
`api.getUser({ id }).pipe(Effect.timeout("5 seconds"))`, not a signal that replaces it.
In a browser, relative routes resolve against the page; elsewhere, give `baseUrl`.

## Rules

- The binding decides what HTTP serves: the actions passed to `make`, and no others; an action has no HTTP switch. To keep an action off HTTP, leave it out of the list. Its implementation may still hold it for MCP, a Toolkit or `ActionCli.make`, which serve the actions their `actions` option lists, or every action of the implementations without it.
- Action names are unique within a binding. Two bindings with different prefixes may reuse a name and be served side by side, but not combined into one `HttpApi`.
- `layer(Http, implementations)` mounts the routes of the binding's actions among the implementations it receives, matched by identity: the exact contract values passed to `make`. Their other actions get no route, and their names are not checked. `actions` narrows it to the listed ones, each of the binding's and held by an implementation, as on every surface ([guarantees.md](guarantees.md#names)); an implementation holding none of those served is left out, and not built. Implementations holding none of the binding's actions at all are refused when `layer` is called, as the wrong implementations or the wrong binding. An equal-looking copy of a bound action is not the bound action, so it is not served.
- An action may be served once per call; two implementations there may both hold an action the binding leaves out. An action no layer serves still appears in `Http.api`, OpenAPI and clients, and answers 404.
- The binding is plain data: `layer` and `client` read everything from its fields, so a copy of the binding, or one made by another installed copy of the package, serves the same.
- One layer serves a binding's public and protected actions, from one implementation or several. Each action's contract decides: a protected route is authenticated by the binding's descriptor, before its body is read ([guarantees.md](guarantees.md#authorization)), and a public one is open, ignoring any credential. A binding holding a protected action names its descriptor, and the layer serving it requires the descriptor's provider ([Authentication.md](Authentication.md#rules)); a layer serving only public actions, of a binding or an implementation holding protected ones too, requires none.
- Router middleware provided to a `layer` call covers that call's routes, before their authentication, and no others. Several layers over one binding, such as one per area of the host, still share one binding, one document and one client.
- `middleware` takes native `HttpApiMiddleware` services, which run around every route the layer serves, inside a protected route's authentication and outside its content-type and schema checks, so they see a decoding failure as the failure of `route`. The first listed is innermost, as native `.middleware` chaining is. The layer requires each one's service, and owes what each requires, less what one further out provides, in that order; a list not written as a tuple, or options whose `middleware` may be absent, owe what any of them requires, and provide nothing. `layer` takes options or none; an explicit type argument naming middleware requires the options argument, and a misspelled option beside `middleware` is a type error. A reusable options value names its tuple, `ActionHttp.LayerOptions<readonly [typeof Audit]>`, or is written `as const`: bare `ActionHttp.LayerOptions` takes no middleware.
- A layer middleware may require the identity only where every action the layer serves is protected: on a layer serving a public action too, the identity stays owed. List the protected actions in its `actions`, and serve the public ones from another layer: `ActionHttp.layer(Http, users, { actions: [RenameUser], middleware: [Audit] })` beside `ActionHttp.layer(Http, users, { actions: [GetUser] })`. Options whose `actions` may be absent narrow nothing.
- A layer middleware fails only with the binding's `error` or a built-in error, and needs no client: anything else is a type error, since clients decode only what the binding and every endpoint declare ([Binding errors](#binding-errors)). A middleware refusing a caller, such as an address allowlist, fails with `Action.Forbidden`, which needs no binding error. It is where a limit keyed by the caller runs before decoding, so it counts input that does not decode too; a limit after decoding, on every surface, is the handler's, failing with an error the contract declares ([Action.md](Action.md#implementations)). A middleware observing failures uses `Effect.onExit`, not `Effect.map`, which a failure skips. A step-up refusal is answered as it leaves the layer's middleware: one that recovers from it keeps its own response, and one that turns it into another error the binding declares answers with that error ([guarantees.md](guarantees.md#authorization)). MCP endpoints take no layer middleware.
- Authorization, builders, request-time services and headers follow [guarantees.md](guarantees.md): `ActionHttp` itself sets no header.
- `Http.api` is a plain `HttpApi`, which Effect's own tools document and call: `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`, `Http.api.addHttpApi(other)` to combine with other APIs, `HttpApiClient.make`. Serve it with `layer`, not the native `HttpApiBuilder`: its protected endpoints carry the descriptor's native security middleware, which `layer` satisfies with the provider and the native builder lacks.
- The endpoints are one top-level group named after the mount path, so the native client exposes them as `client.<action>({ payload })`.
- Bindings combine into one host API with the native `addHttpApi` method, `HttpApi.make("app").addHttpApi(Http.api)`, for one document or one native client, only when their prefixes differ and no action name repeats across them. An operation ID is the action name, and a group is keyed by its mount path. Serving several bindings with `layer` has neither limit.
- Serve the OpenAPI document as a native route: `HttpRouter.add("GET", "/api/openapi.json", HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)))`. It documents every bound action, not only the served ones. It is a plain route: middleware provided to its layer covers it, and nothing covers it otherwise.
- A route runs only a request typed as JSON: any other type, or none, is a 415, after authentication on a protected route, as on an MCP endpoint, whatever encoding the input is annotated with, such as `HttpApiSchema.asFormUrlEncoded()`, which `HttpApi` would read and no other surface does. So no request a page on another origin can send without a CORS preflight reaches a handler, whatever credentials, cookies included, it carries; one typed as JSON is preflighted, and the host's CORS policy decides.
- A media field, `Action.Image`, is JSON in the body: `{ "data": "<base64>", "mimeType": "image/png" }`, as Effect's JSON codec encodes a `Uint8Array`. The OpenAPI document lists `data` as `type: string`, `format: byte`, `contentEncoding: base64`, as Effect's JSON Schema does, and `client` decodes it to a `Uint8Array`. Only MCP lifts it into a block of its own ([ActionMcp.md](ActionMcp.md#media)).
- Wire format: [guarantees.md](guarantees.md#wire-behavior). Spans and log annotations: [guarantees.md](guarantees.md#observability).

### Binding errors

- The binding's `error`, one schema or a list, is what middleware answers with, on any endpoint, router middleware around the routes and the layer's own `middleware` alike: `ActionHttp.make(actions, { error: RateLimited })`. A binding holds it as a list, `Http.error`. Every endpoint declares them, OpenAPI shows them, and every client decodes them.
- Middleware sends one as the binding declares it, at the status its `httpApiStatus` states, or 422 without one: for `class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {}, { httpApiStatus: 429 }) {}`, `HttpServerResponse.schemaJson(RateLimited)(error, { status: 429 })`. A union with its own `httpApiStatus` uses that status for every member; otherwise, each member of a plain union is declared at its own status, or 422 without one.
- No handler fails with them: it serves every surface, and only HTTP declares them. An action whose handler fails with one lists it in its own `error`, a limit after decoding included ([guarantees.md](guarantees.md#authorization)). A layer middleware fails with them as a native `HttpApiMiddleware` does, declaring the error, `{ error: RateLimited }`, which the binding declares too.
- They may not reuse a built-in error's tag: `make` refuses such a binding.
- Options that may leave `error` out, such as a value annotated `ActionHttp.Options<readonly [typeof RateLimited]>`, declare those errors or none, `readonly [typeof RateLimited] | []`, as the binding has at run time: clients decode each that may arrive, and a layer middleware failing with one is a type error, since the binding may lack it. Give `error` inline, or in a value whose type requires it. Explicit type arguments naming `error` require the options argument, which alone holds them. A layer middleware may fail only with an error the binding surely declares: one in a slot of its own in a list of fixed length, inline `error: RateLimited`, not in an array of unknown length, `[RateLimited, ...more]` included, which may be empty, a slot that may hold either of several, or options whose `error` may be either of two lists.

### Security

- OpenAPI security follows each contract's `caller`. Every protected endpoint carries the descriptor's native security middleware, the one that enforces it: `OpenApi.fromApi`, `HttpApiSwagger` and `HttpApiScalar` show its scheme in `components.securitySchemes`, keyed by the descriptor's name as it is, `example.Login`, and `[{ "example.Login": [] }]` as the operation's requirement, and a public endpoint states `security: []`. A combined document keeps each binding's: distinct descriptors have distinct names, so their schemes never share a key ([Authentication.md](Authentication.md#rules)).
- The document and the routes cannot disagree: no option documents a scheme the routes do not enforce, or a public action the routes protect.
- Effect has no OAuth or OpenID Connect scheme, so an OAuth protected resource is documented as a bearer scheme; its discovery is the provider's ([Authentication.md](Authentication.md#rules)).
- Clients read none of it: a client sends what `transformClient` adds, whatever the document says.

### Client methods

- A method fails with what the native client fails with, but for input: input that does not encode is `InvalidInput` with its `issues`, as every surface answers it, and nothing is sent. Declared errors arrive as their decoded values: the action's own, the binding's, and the three built-in errors every endpoint declares. Match them with `Effect.catchTag`.
- Anything the contract does not account for is Effect's own error:
  - `HttpClientError` with `response` `undefined`: the server could not be reached.
  - `HttpClientError` with `reason._tag` `DecodeError`: the server answered with a status no schema declares, such as the empty 500 of a defect.
  - `HttpClientError` with `StatusCodeError`: a declared status whose body did not decode.
  - `SchemaError`: the success body did not decode.
- The library interprets no status. Which failures mean "signed out" or "try again" is the caller's decision.
- Nothing is retried. A failed write may or may not have happened; only a declared error says what the server did.
- Every action of the binding has a method, whether or not a server serves it. An unserved action answers 404 with no body, so its method fails with `HttpClientError`: `DecodeError`, or `StatusCodeError` when the action declares a 404 error, whose body the empty response is not.
- A given argument is sent as given: `null` or `undefined` is the input itself, for a schema that accepts it.
- The client holds no connections or timers. `client` builds the native client once from the `HttpClient` in context.
- The native client stays available: `HttpApiClient.make(Http.api)` has the same routes, with methods taking `{ payload }`.
- In a browser, import the binding from a module with no server code, so the bundle keeps the client alone ([setup.md](setup.md#browser)).
- In tests, provide `Testing.layer(routes)` instead of a network client; `baseUrl` may be left out ([Testing.md](Testing.md)). `Action.client` has the same methods in process, for what an implementation does without the wire ([Action.md](Action.md#clients)).

### Built-in errors

- Every endpoint declares the built-in errors ([guarantees.md](guarantees.md#wire-behavior)). `client`, a remote `ActionCli` command and the native `HttpApiClient` decode them as typed failures, and OpenAPI shows them on every operation. They cannot be left out; the binding's `error` add to them.
- `InvalidInput`'s `message` is the schema's own description of every issue, and `issues` lists each by its path: `{"_tag":"InvalidInput","message":"Expected string\n  at [\"name\"]","issues":[{"path":["name"],"message":"Expected string"}]}`.

## Failure modes

- Route returns 404: the action is not in the binding, its implementation was never passed to a `layer` call, or the path lacks the prefix. An implementation's action is served only if the binding holds that very value: an equal-looking copy, such as a test declaring the contract again, is not.
- `No action of these implementations is in this HTTP binding: x` thrown by `layer`: none of the implementations' actions was passed to this binding's `make`, so they are the wrong implementations or it is the wrong binding. `x (another contract)` is an action of a bound name that is not the bound value, as a second copy of the contracts module makes: implement the exact contract value the binding received. Matching names and schemas do not establish identity.
- `Authentication "<name>": the binding's descriptor is not its provider's`, a defect when `layer` builds: the binding and `Authentication.layer` were given two descriptors of one name. Build both from one descriptor ([Authentication](Authentication.md#failure-modes)).
- `Listed in actions, but the binding does not hold it: <names>`, or `but no implementation holds it`, thrown by `layer`: those actions are not among the binding's or the implementations', by identity. `(another contract)` marks one whose name the binding holds.
- `Duplicate served action: <name>`: one `layer` call received two implementations of the same bound action.
- `Duplicate middleware: <key>` thrown by `layer`: its `middleware` lists one middleware twice, which a native endpoint would run once. List it once.
- `Method 'POST' already declared for route '<prefix>/<action>'` when the host builds: two `layer` calls serve the same action, such as one implementation given to two layers of one binding. Serve each action in one call: one layer serves public and protected actions alike, or give each layer its own `actions`.
- `ActionHttp binding: error _tag "Forbidden" is built in, and declared on every surface` thrown by `make`: a binding error has a built-in tag, or is a built-in error. Drop a built-in error, which every endpoint declares already; rename an error of your own.
- `Duplicate action: <name>` thrown by `make`: two actions share a name, or one action value is listed twice. Rename one, or bind it under another prefix.
- `Duplicate OpenAPI operationId: <name>` from `OpenApi.fromApi` on a combined API: two combined bindings have an action of that name. Rename one, or document each binding on its own.
- A combined document or native client lacks one binding's actions: two combined bindings share a prefix, so one group replaced the other. Give each its own prefix, or bind the actions together.
- `Provider<CurrentActor, "example.Login">` among the layer's requirements, or `Type 'Provider<...>' is not assignable to type 'never'` where the server is launched: the layer serves a protected action and its descriptor's provider is not provided. Provide it, `Layer.provide(authenticate)` ([Authentication.md](Authentication.md#failure-modes)). Nothing else stands in for it.
- `Type 'X' is not assignable to type 'never'` where the server is launched, or `Request<"Requires", X>` in the layer's type: a handler or the authorizer yields a request service `X` that no middleware around the layer provides. Provide it with router middleware, or `HttpRouter.provideRequest`; never an identity at startup. `X` the identity on a layer serving public actions: a public handler reads it, or a layer middleware requires it. No public route gets an identity: make the action protected, or serve the middleware's protected actions from a layer of their own ([Rules](#rules)).
- `No overload matches this call` at `make`, its last overload naming `"Protected actions take options naming their authentication"`, or a type error naming `authentication`: the binding holds a protected action and names no descriptor, or one of another identity. Give `{ authentication: Login }`, never `caller: Action.Anyone` on the contract to silence it.
- `Argument of type 'Options<…> | undefined' is not assignable` at `make`: a helper forwards options that may be absent. `make` takes options or none, two forms, so pass `options ?? {}`.
- A type error on `middleware` naming `"Layer middleware fails only with the binding's errors and needs no client"`: a middleware declares an error neither the binding nor the built-ins hold, or a client counterpart. Add the error to the binding's `error`, or, for a limit after decoding on every surface, move it to the handlers, declaring it on their actions.
- A route answers without credentials: its contract is `caller: Action.Anyone`. Make it protected; its route is then authenticated, whatever its handler reads.
- A protected route answers 401 to a request missing its content type or sending invalid input: it presented no credential that verifies, and authentication runs before anything reads the body. Send the token, then the content type and the input are checked.
- Swagger shows no Authorize button: the binding holds no protected action.
- `Service not found: effect-actions/Authentication/Security/…` when the host builds: `Http.api` of a binding holding a protected action is served with the native `HttpApiBuilder`. Serve it with `layer`.
- 400 `InvalidInput` on a valid-looking request: its `message` names each field that did not decode, or that the action does not declare, such as a misspelling. An action without input takes only `{}`, and a body.
- 415 `Unsupported content-type: <type>` (`none` when it has none): the request is not typed as JSON. It has another content type, such as `fetch`'s default `text/plain` for a string body, or none, as for a `Blob` body. Send `Content-Type: application/json`, as the clients do.
- Empty 500: a defect, or a handler result that does not match the success schema. The cause is in the server's logs.

### Client methods

- Fails with `HttpClientError` whose `reason._tag` is `DecodeError` for a status such as 429: the server answered with a status no schema declares. Declare that error on the binding, `make`'s `error`, when router middleware answers with it; on the action when its handler does; or handle the native error. The built-in 400, 401 and 403 always decode, as long as their body is the built-in error's JSON.
- Fails with `HttpClientError` whose `reason._tag` is `InvalidUrlError` outside a browser: `baseUrl` is omitted, and there is no page to resolve relative routes against. Set `baseUrl`.
- Type error listing `HttpClient` as an unsatisfied requirement of `client`: provide one, such as `FetchHttpClient.layer`.
- Property does not exist on the client: the action is not in the binding.
- `Expected 1 arguments`: `{}` is not a valid encoded input for the action, so it needs its input.
- Type error passing `undefined` to a method whose argument may be omitted: leave the argument out instead.
- Fails with `InvalidInput` `Expected Filters` given a plain object, which TypeScript may let through: the input is a class, `Filters`, which encodes only its instances. Pass `new Filters({ ... })`, or leave out an argument whose fields are all optional.
- Type error passing `{ payload: ... }`: that is the native client's shape. These methods take the input itself.
