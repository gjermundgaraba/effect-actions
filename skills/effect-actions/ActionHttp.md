# ActionHttp

JSON `POST` routes on Effect's `HttpApi`, one per action. `ActionHttp.make` binds actions to a
mount path; that one binding is what the server mounts (`ActionHttp.layer`), what every client
calls (`ActionHttp.client`, `ActionHttp.fetchClient`) and what the OpenAPI document is generated
from. Reach for it when programs call your actions: a web page, another service, a script.

## API

Import `@gjermundgaraba/effect-actions/ActionHttp`.

| API                                      | Purpose                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `make(actions, options?)`                | Bind a list of actions; returns a `Binding`. Options are required for a protected action.    |
| `Http.actions`                           | The exact bound actions.                                                                     |
| `Http.error`                             | The errors every endpoint declares besides its action's own, as a list.                      |
| `Http.prefix`                            | Where the routes mount.                                                                      |
| `Http.authentication`                    | The authentication descriptor of its protected actions, or `undefined`.                      |
| `Http.api`                               | Native Effect `HttpApi`, for OpenAPI and Effect's own tools.                                 |
| `layer(Http, implementations, options?)` | Mount the routes of the bound actions these implementations hold, or the listed ones.        |
| `client(Http, options?)`                 | An Effect of a typed client; requires the native `HttpClient`, as `HttpApiClient.make` does. |
| `fetchClient(Http, options?)`            | The same client, built over `fetch` outside an Effect: its methods require nothing.          |

Exported types: `Binding`; `Any`, any binding; `Client`, a client's type: `Client<typeof Http>`; `MethodError`, what one of its calls fails with; `Options` of `make`, `LayerOptions` of `layer`, `ClientOptions` of `client` and `FetchClientOptions` of `fetchClient`.

| Option                      | Meaning                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `make`: `prefix`            | Mount path of every route; defaults to `/api`. `/` mounts at the root; a trailing slash is dropped.                               |
| `make`: `error`             | Errors middleware around the routes answers with, one schema or a list: declared by every endpoint, so clients decode them.       |
| `make`: `authentication`    | The descriptor of the protected actions' identity, `Authentication.make(...)`: required when the binding holds one.               |
| `layer`: `actions`          | The bound actions it serves, among the implementations': `[GetUser]`. Defaults to every one they hold.                            |
| `layer`: `middleware`       | Native `HttpApiMiddleware` run around every route the layer serves, inside authentication, outside decoding; the first innermost. |
| `client`: `baseUrl`         | What routes are resolved against, such as `https://api.example.com`. Omitted: relative routes (the page's origin in a browser).   |
| `client`: `transformClient` | Wraps the native `HttpClient`. A bearer token: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.                     |
| `fetchClient`: `fetch`      | What each call sends with; it also takes `client`'s options. Omitted: the global `fetch`, looked up on every call.                |

Each action is served at `POST <prefix>/<action>`, a `readOnly` one too. Statuses and bodies:
[guarantees.md](guarantees.md#wire-behavior).

## Bind actions to routes

Call `ActionHttp.make` once, in a file that imports contracts and no server code, and export the
binding. The server, every client, the CLI and the tests import that one value.

```ts
export const Http = ActionHttp.make([GetStatus, ...Notes, WhoAmI], {
  prefix: "/api",
  authentication: Login,
});
```

Files: [quickstart/src/Api.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/Api.ts) (public actions, no options),
[notes-service/src/Api.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/Api.ts) (protected actions),
[kitchen-sink/src/Api.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/Api.ts) (`prefix`, `error`, two bindings).

- The binding decides what HTTP serves: the listed actions and no others. To keep an action off
  HTTP, leave it out; its implementation may still serve it as a tool or a command.
- A binding holding a protected action names its descriptor
  ([Authentication.md](Authentication.md#declare-how-callers-sign-in)). A binding has one
  descriptor, so a second identity gets a second binding with its own `prefix`. A public action
  may be in both.
- `error` declares what middleware answers with on any route, such as a quota's 429. An error a
  handler fails with goes in its action's `error` instead
  ([Action.md](Action.md#fail-with-declared-and-built-in-errors)).
- Action names are unique within a binding. Split a large API, or two actions sharing a name,
  into one binding per area, each with its own `prefix` and client; one host serves them all.

## Serve the routes

Give `ActionHttp.layer` the binding and the implementations, merge it with the host's other
routes, provide the authentication provider, and serve the result with `HttpRouter.serve`.

```ts
const api = ActionHttp.layer(Http, implementations);

export const routes = Layer.mergeAll(api, mcp, health, openApi).pipe(Layer.provide(authenticate));
```

Files: [quickstart/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/routes.ts) and
[quickstart/src/server.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/server.ts);
[notes-service/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/routes.ts) and
[notes-service/src/server.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/server.ts).

- Pass every surface the same list of implementations: the layer serves the binding's actions
  among them, public and protected alike.
- A layer serving a protected action requires the descriptor's provider
  ([Authentication.md](Authentication.md#verify-credentials)).
- A service a handler or an authorizer reads per request stays owed by the layer until router
  middleware around it, `HttpRouter.provideRequest` or the layer's own `middleware` provides it.
  Never provide an identity or a tenant at startup
  ([Action.md](Action.md#say-who-may-call-an-action)).
- Two listeners are two `HttpRouter.serve` calls, each building its routes on its own. What they
  share is provided outside both ([Action.md](Action-in-process.md#share-one-build-across-servers),
  [kitchen-sink/src/server.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/server.ts)).

Set a request body limit: Effect reads each body whole, with no limit unless the host provides
one to `HttpRouter.serve`, as below. It covers every route of the server, MCP endpoints and the
host's own included, except a body a route reads as a stream. On Node (`NodeHttpServer`), a
request over the limit gets no response: its connection is closed. `HttpRouter.toWebHandler`
ignores the limit, so limit bodies in the platform serving the handler.

```ts
Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1))),
```

### Split a binding across layers, and add middleware

Several layers may serve one binding, each with its own `actions` and `middleware`. They share
its document and client; serve each action from exactly one. Files:
[kitchen-sink/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/routes.ts) (`api`),
[kitchen-sink/src/identity/quota.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/quota.ts).

Where a check runs decides what it sees:

| Where                                                | Runs                                             | Use it for                                                 |
| ---------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| Global router middleware                             | before routing, on every route                   | a Host or Origin policy, CORS                              |
| Router middleware provided to a `layer` call         | around that call's routes, before authentication | a per-request service; a limit on unauthenticated requests |
| The layer's `middleware`                             | after authentication, before decoding            | a limit keyed by the caller, counting invalid input too    |
| The handler ([Action.md](Action.md#authorize-calls)) | after decoding and the authorizer                | a limit that holds on every surface, MCP included          |

- A layer middleware requiring the identity needs a layer serving protected actions only: a
  public route has no identity. Serve the public actions from a second layer without it.
- A layer middleware fails only with a binding error or a built-in one, such as
  `Action.Forbidden`: clients decode nothing else.
- Router middleware answering with a binding error encodes and sends it itself,
  `HttpServerResponse.schemaJson(QuotaExceeded)(error, { status: 429 })`, at the error's
  `httpApiStatus`, or 422 without one: at any other status the client fails with an
  `HttpClientError` instead of the error.
- A request policy that must run before authentication and OAuth discovery:
  [Authentication.md](Authentication-advanced.md#run-a-request-policy-before-authentication).

### Publish the OpenAPI document

`Http.api` is a plain `HttpApi`: give it to `OpenApi.fromApi`, `HttpApiSwagger.layer` or
`HttpApiScalar.layer`, on routes of the host's own. Files:
[notes-service/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/routes.ts) (`openApi`),
[kitchen-sink/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/routes.ts) (`documentation`).

- The document's route is public unless you put middleware around it.
- The document and the clients list every action of the binding, served or not. An action no
  layer serves answers 404.
- An OAuth protected resource is documented as a bearer scheme: Effect has no OAuth scheme
  ([Authentication.md](Authentication.md#publish-oauth-discovery)).
- Serve the binding with `ActionHttp.layer`, never with the native `HttpApiBuilder`.
- One document over several bindings, `HttpApi.make("app").addHttpApi(A.api).addHttpApi(B.api)`,
  works only when their prefixes differ and no action name repeats. Otherwise document each alone.

## Call the API from Effect

`ActionHttp.client` yields a client with one method per action: it takes the action's input and
returns an Effect of its decoded success.

```ts
Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, { baseUrl: "http://127.0.0.1:3000" });

  yield* Console.log(yield* client.greet({ name: "Ada" }));
}).pipe(Effect.provide(FetchHttpClient.layer), NodeRuntime.runMain);
```

Files: [quickstart/src/client.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/client.ts),
[kitchen-sink/src/seed.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/seed.ts) (headers, errors by tag).

- Outside a browser, set `baseUrl`; read it from `Config` before building the client
  ([kitchen-sink/src/seed.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/seed.ts)). A token or any other header
  goes through `transformClient`. Where no client is built by hand, as under `ActionCli.remote`,
  transform the `HttpClient` itself
  ([notes-service/src/cli.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/cli.ts)).
- Leave the argument out when `{}` is a valid input: an action without `input`, or one whose
  fields are all optional or defaulted. A given argument is the decoded input, so it states a
  defaulted field.
- A declared error is a typed failure, as its decoded value: the action's own, the binding's, the
  verifier's, and the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`, which every
  endpoint declares. Handle each with `Effect.catchTag`.
- Anything else is Effect's own: an `HttpClientError` when the server could not be reached or
  answered with a status or body the binding does not declare, such as a defect's empty 500; a
  `SchemaError` when the success does not decode.
- The client interprets no status and retries nothing. A failed write may have happened; only a
  declared error says what the server did.
- A handler calling another service through this client maps that service's `Unauthenticated`
  and `Forbidden` before failing with them
  ([Action.md](Action.md#fail-with-declared-and-built-in-errors)).
- In a test, provide `Testing.layer(routes)` instead of a network client and leave `baseUrl` out
  ([Testing.md](Testing.md#test-routes-in-memory)). To call an implementation without the wire:
  [Action.md](Action-in-process.md#call-actions-in-process).

## Call the API from a browser

Code outside an Effect builds the client once with `ActionHttp.fetchClient` and runs each call
with `Effect.runPromise`.

```ts
const api = ActionHttp.fetchClient(Http, {
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

const note = (id: string) =>
  api.getNote({ id }).pipe(
    Effect.catchTag("NoteNotFound", () => Effect.succeed(undefined)),
    Effect.runPromise,
  );
```

Files: [notes-service/src/browser.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/browser.ts),
[kitchen-sink/src/sdk.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/sdk.ts) (a `baseUrl`, two headers).

- Without `baseUrl` the routes are called on the page's own origin. A page on another origin
  passes `baseUrl`, and the server must allow that origin with `HttpRouter.cors`
  ([kitchen-sink/src/request-policy.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/request-policy.ts), `cors`;
  [ActionMcp.md](ActionMcp.md#allow-browser-clients)).
- An unhandled declared error rejects the promise as its decoded value, so
  `error instanceof Action.Unauthenticated` works in a `catch`. Handle an expected one by its tag
  before `Effect.runPromise`.
- A page on the API's own origin sends its cookies already. From another origin, pass `fetch`:
  `(input, init) => fetch(input, { ...init, credentials: "include" })`, and allow credentials in
  the server's CORS, `HttpRouter.cors({ allowedOrigins, credentials: true })`. A `fetch` of your
  own keeps `init.signal`, which aborts the request when its call is interrupted: a deadline is
  `Effect.timeout` on the call, not a signal that replaces it.
- A route runs only a request typed as JSON and answers any other 415. So what another site's
  page can send without a CORS preflight, such as a form post carrying the user's cookie, never
  reaches a handler; the server's CORS policy decides the rest.
- Import the binding from a module with no server code, or the bundle carries the server
  ([setup.md](setup.md#bundle-for-a-browser)).

## Examples

| File                                                                                 | Shows                                                                      |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [quickstart/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/routes.ts)                     | The smallest `layer`, beside an MCP endpoint.                              |
| [quickstart/src/client.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/src/client.ts)                     | `client` with a `baseUrl`, over `FetchHttpClient`.                         |
| [notes-service/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/routes.ts)               | One layer for public and protected actions, `/healthz`, the OpenAPI route. |
| [notes-service/src/server.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/server.ts)               | The port from `Config`, the request body limit.                            |
| [notes-service/src/browser.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/browser.ts)             | `fetchClient` as promises, declared errors handled by tag.                 |
| [notes-service/src/cli.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/src/cli.ts)                     | An `HttpClient` given its base URL and token from `Config`.                |
| [notes-service/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/test/routes.test.ts)   | A client per caller in memory, and the refusals each gets.                 |
| [kitchen-sink/src/Api.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/Api.ts)                       | `prefix`, `error`, a second binding for a second identity.                 |
| [kitchen-sink/src/routes.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/routes.ts)                 | Two layers of one binding, `actions`, `middleware`, Swagger UI.            |
| [kitchen-sink/src/identity/quota.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/identity/quota.ts) | A layer middleware requiring the caller, failing with a binding error.     |
| [kitchen-sink/src/server.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/server.ts)                 | Two listeners over shared builders and services.                           |
| [kitchen-sink/src/seed.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/seed.ts)                     | `client` with a token and a header, an image input, `Effect.catchTags`.    |
| [kitchen-sink/src/sdk.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/src/sdk.ts)                       | `fetchClient` with a `baseUrl`, for code written with promises.            |
