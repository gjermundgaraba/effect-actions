# ActionHttp

JSON `POST` routes on Effect's `HttpApi`, one per action. `ActionHttp.make` binds actions to a
mount path; the server mounts that one binding, every client calls it and the OpenAPI document is
generated from it.

Read this page alone, in one tool call: pages read together are cut. When something fails,
search [ActionHttp-failures.md](ActionHttp-failures.md). Reading order: [SKILL.md](SKILL.md).

## API

Import `@gjermundgaraba/effect-actions/ActionHttp`.

| API                                      | Purpose                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `make(actions, options?)`                | Bind a list of actions; returns a `Binding`.                            |
| `Http.actions`                           | The bound actions.                                                      |
| `Http.error`                             | The errors every endpoint declares besides its action's own, as a list. |
| `Http.prefix`                            | Where the routes mount.                                                 |
| `Http.authentication`                    | Its protected actions' authentication descriptor, or `undefined`.       |
| `Http.api`                               | The native `HttpApi`, for OpenAPI and Effect's own tools.               |
| `layer(Http, implementations, options?)` | Mount the routes of the bound actions the implementations hold.         |
| `client(Http, options?)`                 | An Effect of a typed client; requires the native `HttpClient`.          |
| `fetchClient(Http, options?)`            | The same client over `fetch`, built outside an Effect.                  |

Exported types: `Binding`; `Any`, any binding; `Client<typeof Http>`, a client's type;
`MethodError`, what one of its calls fails with; `Options` of `make`, `LayerOptions`,
`ClientOptions` and `FetchClientOptions`.

| Option                      | Meaning                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `make`: `prefix`            | Mount path of every route; defaults to `/api`. `/` mounts at the root.                            |
| `make`: `error`             | What middleware around the routes answers with, one schema or a list; every endpoint declares it. |
| `make`: `authentication`    | The protected actions' descriptor, `Authentication.make(...)`; required with a protected action.  |
| `layer`: `actions`          | The bound actions it serves: `[GetUser]`. Defaults to every one the implementations hold.         |
| `layer`: `middleware`       | Native `HttpApiMiddleware` around every route it serves, the first innermost.                     |
| `client`: `baseUrl`         | What routes resolve against: `https://api.example.com`. Omitted: relative ones, a page's origin.  |
| `client`: `transformClient` | Wraps the native `HttpClient`: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.     |
| `fetchClient`: `fetch`      | Its `fetch`, beside `client`'s options. Omitted: the global `fetch`, looked up on every call.     |

Each action is served at `POST <prefix>/<action>`, a `readOnly` one too. One without `success`
answers an empty 200, with no body and no content type, so a hand-written client must not parse
it. One without `input` still takes the body `{}`, typed as JSON. Statuses and bodies:
[guarantees.md](guarantees.md#wire-behavior).

## Bind actions to routes

Call `ActionHttp.make` once, in a file that imports contracts and no server code, and export the
binding: the server, every client, the CLI and the tests import that one value.

```ts
export const Http = ActionHttp.make([GetStatus, ...Notes, WhoAmI], {
  prefix: "/api",
  authentication: Login,
});
```

Files: [quickstart/src/Api.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/src/Api.ts) (public actions, no options),
[notes-service/src/Api.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/Api.ts) (protected actions),
[kitchen-sink/src/Api.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Api.ts) (`prefix`, `error`, two bindings).

- To keep an action off HTTP, leave it out of the binding; its implementation may still serve
  it as a tool or a command.
- A binding holding a protected action names its descriptor
  ([Authentication.md](Authentication.md#declare-how-callers-sign-in)), and has only one: a
  second identity gets a second binding with its own `prefix`. A public action may be in both.
- `error` declares what middleware answers with on any route, such as a quota's 429. An error a
  handler fails with goes in its action's `error`
  ([Action.md](Action.md#fail-with-declared-and-built-in-errors)).
- Action names are unique within a binding. Split a large API, or two actions sharing a name,
  into one binding per area, each with its own `prefix` and client; one host serves them all.

## Serve the routes

Give `ActionHttp.layer` the binding and the implementations, merge it with the host's other
routes, provide the descriptor's provider
([Authentication.md](Authentication.md#verify-credentials)), and serve the result with
`HttpRouter.serve`.

```ts
const api = ActionHttp.layer(Http, implementations);

export const routes = Layer.mergeAll(api, mcp, health, openApi).pipe(Layer.provide(authenticate));
```

Files: [quickstart/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/src/routes.ts) and
[quickstart/src/server.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/src/server.ts);
[notes-service/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/routes.ts) and
[notes-service/src/server.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/server.ts).

- Pass every surface the same list of implementations: the layer serves the binding's actions
  among them.
- A service a handler or an authorizer reads per request stays owed by the layer until router
  middleware around it, `HttpRouter.provideRequest` or the layer's own `middleware` provides it.
  Router middleware is the one that reads the request, such as a header:
  `HttpRouter.middleware<{ provides: Tenant }>()((route) => …)`, given as
  `Layer.provide(resolveTenant.layer)`
  ([kitchen-sink/src/workspaces/tenant.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/workspaces/tenant.ts)).
  Without the type argument it runs and the layer still owes the service.
  `HttpRouter.provideRequest(layer)` builds its layer once, at startup, and gives every request
  that one value: never an identity or a tenant
  ([Action.md](Action.md#say-who-may-call-an-action)).
- Give the server a `host`: `NodeHttpServer.layer(createServer, { port })` without one listens on
  every interface. The examples bind `127.0.0.1`.
- Two listeners are two `HttpRouter.serve` calls, each building its routes on its own. What they
  share is provided outside both
  ([Action-in-process.md](Action-in-process.md#share-one-build-across-servers),
  [kitchen-sink/src/server.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/server.ts)).

Set a request body limit: a body has none unless the host provides one to `HttpRouter.serve`, as
below. It covers every route of the server, MCP endpoints included, except a body a route reads
as a stream. On Node (`NodeHttpServer`), a request over it gets no response, not a 413: its connection is
closed. `HttpRouter.toWebHandler` ignores it, so limit bodies in the platform serving the handler.

```ts
Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1))),
```

An `ErrorReporter` the server runs with is given a declared or built-in failure too, such as a
404 an action declares, with severity `Info`: Effect's `HttpApi` reports every failure of a
route. MCP and RPC report a defect alone. To keep an error out of a tracker, give its class
`readonly [ErrorReporter.ignore] = true`.

### Split a binding across layers, and add middleware

Several layers may serve one binding, each with its own `actions` and `middleware`; serve each
action from exactly one. Files:
[kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts) (`api`),
[kitchen-sink/src/identity/quota.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/quota.ts).

| Where                                                | Runs                                     | Use it for                                                 |
| ---------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Global router middleware                             | before routing, on every route           | a Host or Origin policy, CORS                              |
| Router middleware provided to a `layer` call         | around its routes, before authentication | a per-request service; a limit on unauthenticated requests |
| The layer's `middleware`                             | after authentication, before decoding    | a limit keyed by the caller, counting invalid input too    |
| The handler ([Action.md](Action.md#authorize-calls)) | after decoding and the authorizer        | a limit that holds on every surface, MCP included          |

- A layer middleware requiring the identity needs a layer serving protected actions only. Serve
  the public actions from a second layer without it.
- Router middleware answering with a binding error encodes and sends it itself,
  `HttpServerResponse.schemaJson(QuotaExceeded)(error, { status: 429 })`, at the error's
  `httpApiStatus`, or 422 without one: at any other status the client fails with an
  `HttpClientError`.
- A request policy that must run before authentication and OAuth discovery:
  [Authentication-advanced.md](Authentication-advanced.md#run-a-request-policy-before-authentication).

### Publish the OpenAPI document

Give `Http.api`, a plain `HttpApi`, to `OpenApi.fromApi`, `HttpApiSwagger.layer` or
`HttpApiScalar.layer`, on routes of the host's own. Files:
[notes-service/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/routes.ts) (`openApi`),
[kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts) (`documentation`).

- The document's route is public unless you put middleware around it.
- A header that middleware reads is not in the document: its operations list no `parameters`.
  Add it by rewriting the document,
  `OpenApi.fromApi(Http.api.annotate(OpenApi.Transform, (document) => …))`, or make the value an
  input.
- The document and the clients list every action of the binding, served or not. An action no
  layer serves answers 404.
- An OAuth protected resource is documented as a bearer scheme: Effect has no OAuth scheme
  ([Authentication.md](Authentication.md#publish-oauth-discovery)).
- Serve the binding with `ActionHttp.layer`, never with the native `HttpApiBuilder`.
- One document over several bindings, `HttpApi.make("app").addHttpApi(A.api).addHttpApi(B.api)`,
  works only when their prefixes differ and no action name repeats. Otherwise document each alone.

## Call the API from Effect

`ActionHttp.client` yields a client with one method per action.

```ts
Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, { baseUrl: "http://127.0.0.1:3000" });

  yield* Console.log(yield* client.greet({ name: "Ada" }));
}).pipe(Effect.provide(FetchHttpClient.layer), NodeRuntime.runMain);
```

Files: [quickstart/src/client.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/src/client.ts),
[kitchen-sink/src/seed.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/seed.ts) (`baseUrl` from `Config`,
headers, errors by tag).

- Outside a browser, set `baseUrl`. A token or any other header goes through `transformClient`.
  Where no client is built by hand, as under `ActionCli.remote`, transform the `HttpClient`
  itself (`connection` in [notes-service/src/commands.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/commands.ts)).
- Leave the argument out when `{}` is a valid input. A given argument is the decoded input, so
  it states a defaulted field.
- A declared error is a typed failure, as its decoded value: the action's own, the binding's,
  the verifier's, and the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`. Handle
  each with `Effect.catchTag`.
- Anything else is Effect's own: an `HttpClientError` when the server could not be reached or
  answered with a status or body the binding does not declare, such as a defect's empty 500; a
  `SchemaError` when the success does not decode.
- The client interprets no status and retries nothing. A failed write may have happened; only a
  declared error says what the server did.
- A handler calling another service through this client maps that service's `Unauthenticated`
  and `Forbidden` before failing with them
  ([Action.md](Action.md#fail-with-declared-and-built-in-errors)).
- In a test, provide `Testing.layer(routes)` instead of a network client and leave `baseUrl` out
  ([Testing.md](Testing.md#test-routes-in-memory),
  [notes-service/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/test/routes.test.ts)).

## Call the API from a browser

Code outside an Effect builds the client once with `ActionHttp.fetchClient` and runs each call
with `Effect.runPromise`. Files:
[notes-service/src/browser.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/src/browser.ts),
[kitchen-sink/src/sdk.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/sdk.ts) (a `baseUrl`, two headers).

- A page on another origin passes `baseUrl`, and the server must allow that origin with
  `HttpRouter.cors`
  ([kitchen-sink/src/request-policy.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/request-policy.ts), `cors`).
- An unhandled declared error rejects the promise as its decoded value, so
  `error instanceof Action.Unauthenticated` works in a `catch`. Handle an expected one by its tag
  before `Effect.runPromise`.
- A page on the API's own origin sends its cookies already. From another origin, pass `fetch`:
  `(input, init) => fetch(input, { ...init, credentials: "include" })`, and allow credentials in
  the server's CORS, `HttpRouter.cors({ allowedOrigins, credentials: true })`. A `fetch` of your
  own keeps `init.signal`, which aborts the request when its call is interrupted: a deadline is
  `Effect.timeout` on the call.
- A route answers a request not typed as JSON with 415, so what another site's page can send
  without a CORS preflight, such as a form post carrying the user's cookie, never reaches a
  handler; the server's CORS policy decides the rest.
- The page imports the binding from a module with no server code
  ([setup.md](setup.md#bundle-for-a-browser)).
