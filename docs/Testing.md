# Testing

In-memory calls against served layers, through Effect's own `HttpClient`. Needs no extra
dependency and opens no port. It tests what the wire does: routes and tools, authentication,
statuses and codecs as sent. What an implementation does, its hook and its handlers, is tested
in process with `Action.client` ([Implementations](#implementations)).

## API

Import `@gjermundgaraba/effect-actions/Testing`.

| API                                     | Purpose                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `layer(routes)`                         | A `Layer<HttpClient>` answering requests with `routes` in memory.                   |
| `layer(handler)`                        | A `Layer<HttpClient>` answering requests with a web handler the test serves.        |
| `mcpClient(actions, options?)`          | An Effect of a client calling each action's tool, like `ActionHttp.client`.         |
| `mcpRequest(method, params?, options?)` | One request an `ActionMcp` endpoint serves, answering the response as sent.         |
| `McpCallError`                          | What a client method fails with for an answer it cannot decode; `message` holds it. |

| Option                         | Meaning                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `url`                          | The endpoint, resolved by the `HttpClient` (relative under `layer`); default `/mcp`, the `ActionMcp.layerHttp` default.        |
| `mcpClient`: `transformClient` | Wraps the native `HttpClient`, as `ActionHttp.client` takes it: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`. |
| `mcpClient`: `tools`           | The endpoint's `tools`, as `ActionMcp.layerHttp` takes them: a text field it sends raw is put back before the success decodes. |
| `mcpRequest`: `headers`        | Request headers.                                                                                                               |

Exported types: `McpClient<Actions>`, a client's type; `McpClientOptions<A>` of `mcpClient`, which types `tools` by the client's actions, and `McpRequestOptions` of `mcpRequest`.

`mcpClient(actions, options)` builds a client on the `HttpClient` in context, one method per
action, called as a client method is: `mcp.getUser({ id })`. For every tool one implementation
serves, pass its actions: `Testing.mcpClient(userActions.actions)`. A method succeeds with the
action's decoded success. It fails with the action's declared errors and the built-in ones as
decoded values, `SchemaError`, `HttpClientError`, or `McpCallError` for any other answer.
Only a tool result carries the action's own errors; any other response decodes only as a
refusal, as authentication and a hook send. The input may be left out when `{}` is a valid
input, sending the input `{}` decodes to, and a given input is sent as given, as for a client's
method.

## Canonical

```ts
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
`ActionHttp.client` gives, and each call runs the hook and the handler, with every check a
surface makes on its input, its success and its failure ([Action.md](Action.md#clients)). Each
call takes its caller, so one test has several, and an action no binding holds, such as a
tool, has a method like any other.

```ts
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
  // its input, runs the hook, then the handler, and checks the success or the failure.
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

### One caller

Routes whose handlers read a caller, on the wire without authentication: provide the caller
around `layer`, like any other service the routes require, and the test program shares what it
reads. One `layer` is one caller; several are called in process
([Implementations](#implementations)).

```ts
import { Effect, Layer } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { actors, CurrentActor } from "./authorization.js";
import { Http } from "./binding.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

// The handlers behind their hook, as one caller standing in for authentication. The
// services provided around the layer are the program's too, one instance.
const asReader = Testing.layer(ActionHttp.layer(Http, userActions)).pipe(
  Layer.provide(Layer.succeed(CurrentActor, actors.reader)),
  Layer.provideMerge(Users.layerMemory),
);

const program = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http);
  const refused = yield* Effect.flip(client.renameUser({ id: "1", name: "Bea" })); // Forbidden
  const users = yield* Users;

  return { refused, unchanged: yield* users.get("acme", "1") };
});

console.log(await Effect.runPromise(program.pipe(Effect.provide(asReader))));
```

## Rules

- `layer(routes)` builds the routes with request logging off, and releases them with the layer's scope. What the routes still require is the layer's, as under `HttpRouter.serve`: their builders' services, and any per-request service no middleware of theirs provides, including one a global middleware reads. Provide them around it, with `Layer.provideMerge` where the program reads them too, so the handlers and the program share one instance. A per-request service provided there, such as a caller, reaches every request; authentication among the routes still provides its own. Each `layer` builds the routes anew, builders included, unless `Action.layer` built them above it. Requests run in the context the layer is built in, as under `HttpRouter.serve`: a `TestClock` or a reference provided around the program reaches middleware and handlers.
- `layer` never requires the platform services `FileSystem`, `Path`, `HttpPlatform` and `Etag.Generator`, but they follow the same rule: at build and per request, the routes get the ones provided around `layer`, and `HttpServer.layerServices`' defaults for the rest, whose `FileSystem` is a no-op. The default `HttpPlatform` reads files through the `FileSystem` provided around `layer`.
- A relative URL resolves against `http://localhost`, once any `baseUrl` a client adds is applied, so `ActionHttp.client(Http)` needs no `baseUrl` under `layer`, and one given is kept. Every request on this client is answered by the routes, whatever its host, so the native `HttpApiClient` and a remote `ActionCli` command work in memory too.
- The client is `layer`'s own: the program's other HTTP clients get none of its requests, and it none of theirs, whether a `FetchHttpClient` is built before or after it or a `FetchHttpClient.Fetch` is provided around the program.
- `layer(handler)` gives the same client, answered by a web handler the test serves, such as `HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices))).handler` shared with tests that send it `Request`s: the routes are built once, by the handler, for every `layer` given it. The web handler needs the routes' platform services, which `HttpServer.layerServices` provides and `layer(routes)` supplies itself. The test owns the handler: `layer` neither builds nor disposes it, so the test calls `dispose` when it is done.
- A client method sends one stateless `tools/call` for the action's tool, at the protocol version `ActionMcp.layerHttp` serves, 2026-07-28, in both the header and `_meta`. It encodes the input with the action's schema, and decodes the success from `structuredContent`, as `ActionHttp.client` does for a route. It reads a JSON or an event-stream response.
- Give `mcpClient` the endpoint's `tools` when they name a text field ([ActionMcp.md](ActionMcp.md#text-fields)): a success the endpoint sent with the field raw, as the first of two text blocks, has the field put back into its structured content before it decodes. Without them, the success decodes without the field. An entry of an action the client does not call is not read, so one `tools` constant, declared `as const`, serves the endpoint and every client that calls one of the actions it names; give a client that calls none of them no `tools`.
- A declared error, the action's own or a built-in one, is a typed failure of its decoded value: an `isError` result from the tool, or a 401 or 403 from the endpoint's authentication or a hook, whose body is the same JSON. Match it with `Effect.catchTag`, exactly as on the HTTP client.
- Any other answer fails with `McpCallError`, whose `message` holds it: another status, the native server's own text (invalid arguments, a defect), no reply, a result without `structuredContent`, or a JSON-RPC error (an unknown tool). Match it with `Effect.catchTag("McpCallError", ...)`.
- The input is typed, so a malformed call cannot be sent through a client method. To assert on a malformed call, another MCP method or the response itself, such as a refusal's status and `WWW-Authenticate` challenge, use `mcpRequest(method, params, options)`.
- `mcpRequest` sends one stateless request as a client method does, with `mcp-name` from `params.name` and the client metadata in `_meta`. A `_meta` in `params`, such as a `progressToken`, is merged over the client metadata, and the protocol version is always the request's own. It succeeds with the response whatever its status.
- To assert on a result's exact bytes, such as a size bound, parse the text of `mcpRequest`'s JSON response: `JSON.stringify` of the parsed message reproduces what the server wrote, less its final newline, so `JSON.stringify(message.result)` is the result as encoded.
- A request under `layer` carries the `Host` header of its URL, `localhost` for a relative one, unless it sets its own, so middleware checking the host answers as it would over the network.
- Add `Authorization` through `transformClient`, the same options for `mcpClient` and `ActionHttp.client`: one client per caller, `const alice = { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")) }`. `mcpRequest` takes `headers`.
- A client names each tool by its action and holds no connection. Duplicate action names throw `Duplicate action: <name>`.
- Test what an implementation does in process, with `Action.client`: its hook, its handlers, and the checks every surface makes on input, success and failure, with several callers, an action no binding holds included. Test what a surface adds under `layer`: authentication, statuses, headers, bodies as sent, MCP results and text fields. The two call the same methods. Cover each surface the application exposes.

## Failure modes

- Fails with `Action.Unauthenticated`: the call reached authentication without a valid credential. Give the client a `transformClient` adding it, such as `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.
- `MCP tools/call "<name>" returned an error: Invalid parameters for tool ...`: the endpoint serves a different contract under that name than the one passed. Call it with the served contract value.
- 404 from a client method: the action's implementation was not passed to any `ActionHttp.layer` call of its binding in the served routes, or `baseUrl` adds a path the routes do not have. Include `ActionHttp.layer(Http, implementations)` in the routes.
- The program reads a service the handlers never changed: it was provided inside the routes and again to the program, two instances. Provide it once, around `layer`, with `Layer.provideMerge`.
- `Type 'CurrentActor' is not assignable to type 'never'` where the test runs, such as at `Effect.runPromise`: a route needs the identity per request and no authentication among the routes provides it. Provide the authentication around the routes, or the caller around `layer` ([One caller](#one-caller)).
- `Argument of type 'Layer<…, FileSystem | Generator | HttpPlatform | HttpRouter | Path>' is not assignable` at `HttpRouter.toWebHandler(routes)`, then `No overload matches this call` at `layer(web.handler)`, its last overload naming `Layer<unknown, unknown, unknown>`, or `Expected 2 arguments, but got 1` at `web.handler(request)`: the web handler's routes lack their platform services. Provide them: `HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)))`.
- A builder or handler finds no file where one exists, failing with `NotFound: FileSystem.<method> (<path>)`, or a file route answers 500: nothing provided a `FileSystem` around `layer`, so the routes read a no-op one. Provide `NodeFileSystem.layer` or `NodeServices.layer` around it, with `Layer.provideMerge` where the program reads files too.
- `MCP tools/call "<name>" answered 404`: the endpoint is not at `/mcp`. Pass its `url`.
- A client method fails with a `SchemaError` naming a missing field, `at ["markdown"]`, or succeeds without an optional one: the endpoint sends that field as text. Give `mcpClient` the endpoint's `tools`.
- Type error at `mcpClient`, `... has no properties in common with type 'ToolOptions<...>'`: the client calls none of the actions its `tools` names. Leave `tools` out of that client's options.
- An `HttpClientError` whose reason is `InvalidUrlError`, from a client method on an `HttpClient` other than `layer`'s: a relative `url` resolves only under `layer`. Pass an absolute `url`.
