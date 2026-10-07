# Testing

In-memory calls against served layers, through Effect's own `HttpClient`. Needs no extra
dependency and opens no port. It tests what the wire does: routes and tools, authentication,
statuses and codecs as sent. What an implementation does, its authorization and its handlers, is tested in process with `Action.client` ([Implementations](#implementations)).

## API

Import `@gjermundgaraba/effect-actions/Testing`.

| API                                     | Purpose                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `layer(routes)`                         | A `Layer<HttpClient>` answering requests with `routes` in memory.                   |
| `layer(handler)`                        | A `Layer<HttpClient>` answering requests with a web handler the test serves.        |
| `mcpClient(actions, options?)`          | An Effect of a client calling each action's tool, like `ActionHttp.client`.         |
| `mcpRequest(method, params?, options?)` | One request an `ActionMcp` endpoint serves, as the native request the test sends.   |
| `McpCallError`                          | What a client method fails with for an answer it cannot decode; `message` holds it. |

| Option                         | Meaning                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                          | The endpoint, resolved by the `HttpClient` (relative under `layer`, or one prepending a base URL); default `/mcp`, the `ActionMcp.layerHttp` default. |
| `mcpClient`: `transformClient` | Wraps the native `HttpClient`, as `ActionHttp.client` takes it: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.                        |
| `mcpRequest`: `headers`        | Request headers.                                                                                                                                      |

Exported types: `McpClient<Actions>`, a client's type; `McpClientOptions` of `mcpClient`; `McpRequestOptions` of `mcpRequest`, and `McpParams`, its `params`.

`mcpClient(actions, options)` builds a client on the `HttpClient` in context, one method per
action, called as a client method is: `mcp.getUser({ id })`. For every tool one implementation
serves, pass its actions: `Testing.mcpClient(userActions.actions)`. A method succeeds with the
action's decoded success. It fails with the action's declared errors and the built-in ones as
decoded values, `SchemaError`, `HttpClientError`, or `McpCallError` for any other answer.
Only a tool result carries the action's own errors; any other response decodes only as a
refusal, as authentication and an authorizer send. The input may be left out when `{}` is a valid
input, sending the input `{}` decodes to, and a given input is sent as given, as for a client's
method.

## Canonical

```ts example=testing.ts
import { Effect } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Greet, Http } from "./quickstart.js";
import { routes } from "./quickstart-server.js";

const program = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http);
  const greeting = yield* client.greet({ name: "Ada" });

  // The same action as a tool of `/mcp`, called like the client's method.
  const mcp = yield* Testing.mcpClient([Greet]);
  const called = yield* mcp.greet({ name: "Ada" });

  return { greeting, called };
});

// The routes answer in memory for the program's scope, and are released after it.
console.log(await Effect.runPromise(program.pipe(Effect.provide(Testing.layer(routes)))));
```

### Implementations

What an implementation does, with no transport between: `Action.client` gives the methods
`ActionHttp.client` gives, and each call runs the authorizer and the handler, with every
check a surface makes on its input, its success and its failure ([Action.md](Action.md#clients)). Each
call takes its caller, so one test has several, and an action no binding holds, such as a
tool, has a method like any other.

```ts example=in-process.ts
import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { actors, CurrentActor } from "./authorization.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

// Each call names its caller, as authentication names one per request.
const asAlice = Effect.provideService(CurrentActor, actors.alice);

const asReader = Effect.provideService(CurrentActor, actors.reader);

const program = Effect.gen(function* () {
  // Acquired once, as a layer is built: the builders run here, not per call.
  const users = yield* Action.client(userActions);

  // The methods of `ActionHttp.client(Http)`, with no transport between: each call decodes
  // its input, runs `authorize`, then the handler, and checks the success or the failure.
  const renamed = yield* users.renameUser({ id: "1", name: "Bea" }).pipe(asAlice);
  const refused = yield* Effect.flip(users.renameUser({ id: "1", name: "Cy" }).pipe(asReader));
  const { changes } = yield* users.listChanges().pipe(asReader); // not an HTTP route

  return { renamed, refused, changes };
});

// The builders are released with the program's scope, before the services they captured.
console.log(
  await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Users.layerMemory))),
);
```

### Signed-in callers

Protected routes on the wire: serve them behind their authentication, the real provider or a
test verifier of the same descriptor, and give each client its caller's credential. One `layer`
serves every caller; the test program shares what the routes read, such as `Users`.

```ts example=testing-caller.ts
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { authenticate } from "./authentication.js";
import { Http } from "./binding.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

// The routes behind their real authentication; the caller is the token each client sends.
const routes = Testing.layer(
  ActionHttp.layer(Http, userActions).pipe(Layer.provide(authenticate)),
).pipe(Layer.provideMerge(Users.layerMemory));

const as = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

const program = Effect.gen(function* () {
  const reader = yield* ActionHttp.client(Http, as("reader"));
  const refused = yield* Effect.flip(reader.renameUser({ id: "1", name: "Bea" })); // Forbidden
  const users = yield* Users;

  return { refused, unchanged: yield* users.get("acme", "1") };
});

console.log(await Effect.runPromise(program.pipe(Effect.provide(routes))));
```

A verifier needing infrastructure in production is replaced, for a test, by another `layer` of the
same descriptor: `Authentication.layer(Login, (token) => ...)`.
Any provider of that descriptor satisfies the routes; nothing else does.

## Rules

- `layer(routes)` builds the routes with request logging off, and releases them with the layer's scope. What the routes still require is the layer's, as under `HttpRouter.serve`: their builders' services, and any per-request service no middleware of theirs provides, including one a global middleware reads. Provide them around it, with `Layer.provideMerge` where the program reads them too, so the handlers and the program share one instance. A per-request service provided there, such as a tenant, reaches every request. A protected action's identity is not such a service: its routes require their authentication provider, which nothing provided around `layer` replaces ([Signed-in callers](#signed-in-callers)). Each `layer` builds the routes anew, builders included, unless `Action.layer` built them above it. Requests run in the context the layer is built in, as under `HttpRouter.serve`: a `TestClock` or a reference provided around the program reaches middleware and handlers.
- `layer` never requires the platform services `FileSystem`, `Path`, `HttpPlatform` and `Etag.Generator`, but they follow the same rule: at build and per request, the routes get the ones provided around `layer`, and `HttpServer.layerServices`' defaults for the rest, whose `FileSystem` is a no-op. The default `HttpPlatform` reads files through the `FileSystem` provided around `layer`.
- A relative URL resolves against `http://localhost`, once any `baseUrl` a client adds is applied, so `ActionHttp.client(Http)` needs no `baseUrl` under `layer`, and one given is kept. Every request on this client is answered by the routes, whatever its host, so the native `HttpApiClient` and a remote `ActionCli` command work in memory too.
- The client is `layer`'s own: the program's other HTTP clients get none of its requests, and it none of theirs, whether a `FetchHttpClient` is built before or after it or a `FetchHttpClient.Fetch` is provided around the program.
- `layer(handler)` gives the same client, answered by a web handler the test serves, such as `HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices))).handler` shared with tests that send it `Request`s: the routes are built once, by the handler, for every `layer` given it. The web handler needs the routes' platform services, which `HttpServer.layerServices` provides and `layer(routes)` supplies itself. The test owns the handler: `layer` neither builds nor disposes it, so the test calls `dispose` when it is done.
- A client method sends one stateless `tools/call` for the action's tool, at the protocol version `ActionMcp.layerHttp` serves, 2026-07-28, in both the header and `_meta`. It encodes the input with the action's schema, and decodes the success from `structuredContent`, as `ActionHttp.client` does for a route. It reads a JSON or an event-stream response.
- A declared error, the action's own or a built-in one, is a typed failure of its decoded value: an `isError` result from the tool, or a 401 or 403 from the endpoint's authentication or an authorizer, whose body is the same JSON. Match it with `Effect.catchTag`, exactly as on the HTTP client.
- Any other answer fails with `McpCallError`, whose `message` holds it: another status, the native server's own text (invalid arguments, a defect), no reply, a result without `structuredContent`, or a JSON-RPC error (an unknown tool). Match it with `Effect.catchTag("McpCallError", ...)`.
- The input is typed, so a malformed call cannot be sent through a client method. To assert on a malformed call, another MCP method or the response itself, such as a refusal's status and `WWW-Authenticate` challenge, send `mcpRequest(method, params, options)`.
- `mcpRequest` is one stateless request as a client method sends it, a native `HttpClientRequest` the test sends itself: with `mcp-name` from `params.uri` for `resources/read` and from `params.name` otherwise, and the client metadata in `_meta`. A `_meta` in `params`, such as a `progressToken`, is merged over the client metadata, and the protocol version is always the request's own.
- Under `layer`, send it with `HttpClient.execute(Testing.mcpRequest("tools/list"))`, which succeeds with the response whatever its status.
- A Promise test sends it as a web `Request`, to a web handler or to `fetch`, for a web `Response` back: `handler(Result.getOrThrow(HttpClientRequest.toWebResult(Testing.mcpRequest(method, params, { url: "http://localhost/mcp" }))))`. The `url` is absolute, the handler's origin or a listening server's, since a web `Request` has no `HttpClient` to resolve a relative one.
- A tool call the typed client would not send is `mcpRequest("tools/call", { name, arguments })`, its result read from the response's JSON: `result.structuredContent`, or `result.isError` and `result.content`.
- To assert on a result's exact bytes, such as a size bound, parse the text of an `mcpRequest`'s JSON response: `JSON.stringify` of the parsed message reproduces what the server wrote, less its final newline, so `JSON.stringify(message.result)` is the result as encoded.
- A request under `layer` carries the `Host` header of its URL, `localhost` for a relative one, unless it sets its own, so middleware checking the host answers as it would over the network.
- Add `Authorization` through `transformClient`, the same options for `mcpClient` and `ActionHttp.client`: one client per caller, `const alice = { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")) }`. `mcpRequest` takes `headers`.
- A client names each tool by its action and holds no connection. Duplicate action names throw `Duplicate action: <name>`.
- Test what an implementation does in process, with `Action.client`: its authorizer, its handlers, and the checks every surface makes on input, success and failure, with several callers, an action no binding holds included. Test what a surface adds under `layer`: authentication, statuses, headers, bodies as sent and MCP results. The two call the same methods. Cover each surface the application exposes.

## Failure modes

- Fails with `Action.Unauthenticated`: the call reached authentication without a valid credential. Give the client a `transformClient` adding it, such as `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.
- `MCP tools/call "<name>" returned an error: Invalid parameters for tool ...`: the endpoint serves a different contract under that name than the one passed. Call it with the served contract value.
- 404 from a client method: the action's implementation was not passed to any `ActionHttp.layer` call of its binding in the served routes, or `baseUrl` adds a path the routes do not have. Include `ActionHttp.layer(Http, implementations)` in the routes.
- The program reads a service the handlers never changed: it was provided inside the routes and again to the program, two instances. Provide it once, around `layer`, with `Layer.provideMerge`.
- `Type 'Provider<CurrentActor, "example.Login">' is not assignable to type 'never'` where the test runs, such as at `Effect.runPromise`: the routes serve a protected action and no provider of its descriptor is provided to them. Provide it to the routes, `ActionHttp.layer(Http, app).pipe(Layer.provide(authenticate))`, or a test verifier of the same descriptor. A caller provided around `layer` does not satisfy it ([Signed-in callers](#signed-in-callers)).
- `Type 'CurrentActor' is not assignable to type 'never'` where the test runs: a public action's handler reads the identity, which no route provides it. Make the action protected.
- A protected route answers 401 where the test expects a 415 or a 400: the request carries no credential that verifies, and authentication runs first. Send a token with requests about something else.
- `Argument of type 'Layer<…, FileSystem | Generator | HttpPlatform | HttpRouter | Path>' is not assignable` at `HttpRouter.toWebHandler(routes)`, then `No overload matches this call` at `layer(web.handler)`, its last overload naming `Layer<unknown, unknown, unknown>`, or `Expected 2 arguments, but got 1` at `web.handler(request)`: the web handler's routes lack their platform services. Provide them: `HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)))`.
- A builder or handler finds no file where one exists, failing with `NotFound: FileSystem.<method> (<path>)`, or a file route answers 500: nothing provided a `FileSystem` around `layer`, so the routes read a no-op one. Provide `NodeFileSystem.layer` or `NodeServices.layer` around it, with `Layer.provideMerge` where the program reads files too.
- `MCP tools/call "<name>" answered 404`: the endpoint is not at `/mcp`. Pass its `url`.
- `HttpClientRequest.toWebResult` or `toWeb` of an `mcpRequest` fails with `UrlError`: its `url` is the relative default. Pass an absolute `url`.
- An `HttpClientError` whose reason is `InvalidUrlError`, from a client method or a sent `mcpRequest` on an `HttpClient` that prepends no base URL: a relative `url` resolves under `layer`, and under a client that prepends one, such as `NodeHttpServer.layerTest`'s. Pass an absolute `url`.
