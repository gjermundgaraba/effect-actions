# ActionHttp

JSON `POST` routes on Effect's `HttpApi`. `ActionHttp.make` binds actions to a mount path; the
binding is shared by the server, every client, and the OpenAPI document. Servers mount it with
`ActionHttp.layer(Http, implementations)`, running each implementation's hook, under whatever
middleware the host provides around it, authentication included; clients call it with
`ActionHttp.client(Http)`.

## API

Import `@gjermundgaraba/effect-actions/ActionHttp`.

| API                       | Purpose                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `make(actions, options?)` | Bind a list of actions; returns `Http`.                                                      |
| `Http.actions`            | The exact bound actions.                                                                     |
| `Http.prefix`             | The mount path: `/api` by default, empty at the root.                                        |
| `Http.api`                | Native Effect `HttpApi` for clients and OpenAPI.                                             |
| `layer(Http, apps)`       | Mount the routes of these implementations, each behind its `before` hook.                    |
| `openApi(Http, path?)`    | Serve the OpenAPI document with `GET path`; defaults to `<prefix>/openapi.json`.             |
| `client(Http, options?)`  | An Effect of a typed client; requires the native `HttpClient`, as `HttpApiClient.make` does. |

Exported types: `Http`, and `Client`, a client's type: `Client<typeof Http>`.

| Option                      | Meaning                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `make`: `prefix`            | Mount path of every route; defaults to `/api`. `/` mounts at the root; a trailing slash is dropped.                             |
| `client`: `baseUrl`         | What routes are resolved against, such as `https://api.example.com`. Omitted: relative routes (the page's origin in a browser). |
| `client`: `transformClient` | Wraps the native `HttpClient`. A bearer token: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.                   |

Routes: each action is served at `POST <prefix>/<action>`, operation ID `<action>`. The
OpenAPI tag is the mount path's segments (`api`, `v2/api`), or `/` at the root. Every
endpoint declares its action's errors plus the built-in `InvalidInput` (400),
`Unauthenticated` (401) and `Forbidden` (403).

Layer failures and startup requirements come from the builders of the supplied
implementations. Every handler's and hook's request services remain router request
requirements until middleware provided around the layer, such as authentication, provides them;
router/platform services are also required. No request identity is supplied at startup.

## Canonical

The binding, shared by the server and every client:

```ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Double, GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";

// Contract-level: the server and its clients share it, and it is plain data. Every
// endpoint also declares the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`,
// so a typed client decodes a malformed request, the authentication's 401 and the
// authorization hook's 403 instead of reporting a decode error. `ListChanges` is a tool
// for agents reviewing what happened, so HTTP leaves it out.
export const Http = ActionHttp.make([Status, GetUser, RenameUser, Double, WhoAmI]);
```

### Serving

```ts
import { Layer } from "effect";
import { HttpApiSwagger } from "effect/unstable/httpapi";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { authenticate } from "./authentication.js";
import { Http } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

// One binding, two layers: authentication covers the routes of the layer it is provided
// to, so `status` stays public while the others authenticate.
const routes = Layer.mergeAll(
  ActionHttp.layer(Http, status),
  ActionHttp.layer(Http, [userActions, double]).pipe(Layer.provide(authenticate)),
);

// `Http.api` is a native HttpApi, so documents are Effect's own: the OpenAPI JSON at
// `GET /api/openapi.json`, and a Swagger UI reading the same contract.
const documentation = Layer.mergeAll(
  ActionHttp.openApi(Http),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
);

export const layer = Layer.mergeAll(routes, documentation);
```

Serve with `HttpRouter.serve(layer).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })), Layer.launch)`.

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
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
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
`input` (`client.whoAmI()`) or one whose fields are all optional; omitting it sends `{}`. Other
headers also go through `transformClient`
(`HttpClient.mapRequest(HttpClientRequest.setHeader("x-agent", agent))`). The options are the
native `HttpApiClient.make` options except `transformResponse`, which may change a call's
success, failure or required services, which the method types cannot follow; use
`transformClient`, or the native client. Code that does not run Effects runs the program with
`Effect.runPromise`, as above.

## Rules

- HTTP serves exactly the actions passed to `make`; an action has no HTTP switch. To keep an action off HTTP, leave it out of the list and serve it elsewhere (MCP, Toolkit, CLI).
- Action names are unique within a binding. Two bindings with different prefixes may reuse a name and be served side by side, but not combined into one `HttpApi`.
- `layer(Http, apps)` mounts the routes of every action of the implementations it receives. Each action must be the exact contract value passed to `make`: an equal-looking action is refused at runtime, and the types refuse only an action of another shape. An action may be served once per call. An action no layer serves still appears in `Http.api`, OpenAPI and clients, and answers 404.
- The binding is plain data: `layer` and `openApi` read everything from its fields, so a copy of the binding, or one made by another installed copy of the package, serves the same.
- Middleware, authentication included, is per layer call: provided to a `layer` call, it covers that call's routes, before decoding, and no others. Public and authenticated actions go in separate `layer` calls over the same binding, merged with `Layer.mergeAll`; they still share one binding, one document and one client. A builder runs once for the host however many calls serve its implementation.
- Each implementation's `before` hook runs after decoding, before each handler; it follows the hook rules in [guarantees.md](guarantees.md#dependency-lifetimes).
- `ActionHttp` sets one header of its own: `WWW-Authenticate: Bearer` on every 401 a hook or handler answers. The host owns cache policy; `Authentication.make` marks the responses of the routes it covers `cache-control: no-store`.
- Request-time handler and hook services are `HttpRouter.Request.From<"Requires", R>`. Supply them with router middleware (`HttpRouter.middleware`, `Authentication.make`), `HttpRouter.provideRequest`, or the request context. Build-time services are ordinary layer requirements.
- `Http.api` is a plain `HttpApi`. Anything Effect can do with an `HttpApi` works: `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`, `HttpApi.addHttpApi` to combine with other APIs, `HttpApiClient.make`. The endpoints are one top-level group named after the mount path, so the native client exposes them as `client.<action>({ payload })`. Bindings combine into one host API with `HttpApi.addHttpApi`, for one document or one native client, only when their prefixes differ and no action name repeats across them: an operation ID is the action name, and a group is keyed by its mount path. Serving several bindings with `layer` has neither limit.
- `openApi(Http, path?)` is `OpenApi.fromApi(Http.api)` as one `GET` route, `<prefix>/openapi.json` unless a path is given. It documents every bound action, not only the served ones. It is a plain route: middleware provided to its layer covers it, and nothing covers it otherwise.
- Wire format: success is the encoded body, a declared error is its JSON encoding with its `httpApiStatus`, a defect is an empty 500. Full table in [guarantees.md](guarantees.md#wire-behavior).
- Each handler runs in a span named after its action, a child of the request span, attributed with `action.name` and `action.access`; its log lines carry the same annotations. Authentication, the hook, decoding and encoding are outside it, in the request span.

### Client methods

- A method fails with exactly what the native client fails with. Declared errors arrive as their decoded values: the action's own and the three built-in errors every endpoint declares. Match them with `Effect.catchTag`.
- Anything the contract does not account for is Effect's own error. `HttpClientError`: the server could not be reached (`response` is `undefined`); or answered with a status no schema declares (`reason._tag` `DecodeError`), such as the empty 500 of a defect; or with a declared status whose body did not decode (`StatusCodeError`). `SchemaError`: the input did not encode, or the success body did not decode.
- The library interprets no status. Which failures mean "signed out" or "try again" is the caller's decision.
- Nothing is retried. A failed write may or may not have happened; only a declared error says what the server did.
- Every action of the binding has a method, whether or not a server serves it. An unserved action answers 404 with no body, so its method fails with `HttpClientError`: `DecodeError`, or `StatusCodeError` when the action declares a 404 error, whose body the empty response is not.
- A given argument is sent as given: `null` or `undefined` is the input itself, for a schema that accepts it.
- The client holds no connections or timers. `client` builds the native client once from the `HttpClient` in context.
- The native client stays available: `HttpApiClient.make(Http.api)` has the same routes, with methods taking `{ payload }`.
- In tests, provide `Testing.layer(routes)` instead of a network client; `baseUrl` may be left out ([Testing.md](Testing.md)).

### Built-in errors

- Every endpoint declares `InvalidInput`, `Unauthenticated` and `Forbidden` beyond the action's own errors, so `client`, a remote `ActionCli` command and the native `HttpApiClient` decode them as typed failures, and OpenAPI shows them on every operation. There is no option to declare more or fewer.
- Input that does not decode, malformed JSON included, is answered **400** `InvalidInput` whose `message` is the schema's own description of every issue: `{"_tag":"InvalidInput","message":"Expected string\n  at [\"name\"]"}`. The hook and handler never run. A wrong content type is Effect's own 415.
- A result that does not encode is a server bug: a defect, answered with an empty **500**. A typed client fails with `HttpClientError` (`DecodeError`, status 500).
- A refusal, from authentication or `before`, is its JSON with 401 or 403. Every 401 refusal, and every 401 a hook or handler answers, carries `WWW-Authenticate: Bearer`. An `HttpServerResponse` that authentication fails with is sent as it is, its challenge the host's ([Authentication.md](Authentication.md)).
- Schemas reachable from one endpoint must have distinct `_tag`s: the client decodes a response by trying the schemas declared for its status. An application error must not reuse a built-in tag (`InvalidInput`, `Unauthenticated`, `Forbidden`); list the built-in error itself instead.
- MCP is unaffected: the native `McpServer` answers invalid arguments itself ([ActionMcp.md](ActionMcp.md)).

## Failure modes

- Route returns 404: the implementation was never passed to a `layer` call, or the path lacks the prefix.
- Type error at `layer`, or `Action "x" is not in this HTTP binding` thrown by it: the implementation's action was not passed to this binding's `make`. Implement the exact contract value the binding received, or add the action to the binding. Matching names and schemas do not establish identity.
- `Duplicate served action: <name>`: one `layer` call received two implementations of the same action.
- `Method 'POST' already declared for route '<prefix>/<action>'` when the host builds: two `layer` calls serve the same action. Serve each action in one call.
- `Duplicate action: <name>` thrown by `make`: two actions share a name, or one action value is listed twice. Rename one, or bind it under another prefix.
- `Duplicate OpenAPI operationId: <name>` from `OpenApi.fromApi` on a combined API: two combined bindings have an action of that name. Rename one, or document each binding on its own.
- A combined document or native client lacks one binding's actions: two combined bindings share a prefix, so one group replaced the other. Give each its own prefix, or bind the actions together.
- Type error listing `HttpRouter.Request.From<"Requires", CurrentActor>` as unsatisfied: a handler or the hook yields a request service that no middleware around the layer provides. Provide the authentication around it, `layer.pipe(Layer.provide(authenticate))` ([Authentication.md](Authentication.md)), or other router middleware.
- An action that should be authenticated answers without credentials: its layer has no authentication around it, and neither its handler nor its hook reads the identity, so nothing in the types asks for one. Provide the authentication around every layer serving it.
- 400 `InvalidInput` on a valid-looking request: its `message` names each field that did not decode. Check it, and `Content-Type: application/json`.
- 415: wrong or missing content type.
- Empty 500: a defect, or a handler result that does not match the success schema. The cause is in the server's logs.

### Client methods

- Fails with `HttpClientError` whose `reason._tag` is `DecodeError` for a status such as 429: the server answered with a status no schema declares. Declare that error on the action, or handle the native error. The built-in 400, 401 and 403 always decode, as long as their body is the built-in error's JSON.
- Fails with `HttpClientError` whose `reason._tag` is `InvalidUrlError` outside a browser: `baseUrl` is omitted, and there is no page to resolve relative routes against. Set `baseUrl`.
- Type error listing `HttpClient` as an unsatisfied requirement of `client`: provide one, such as `FetchHttpClient.layer`.
- Property does not exist on the client: the action is not in the binding.
- `Expected 1 arguments`: `{}` is not a valid input for the action, so it needs its input.
- Type error passing `undefined` to a method whose argument may be omitted: leave the argument out instead.
- Type error passing `{ payload: ... }`: that is the native client's shape. These methods take the input itself.
