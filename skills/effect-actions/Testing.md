# Testing

In-memory calls against served layers, through Effect's own `HttpClient`. Needs no extra
dependency and opens no port.

## API

Import `@gjermundgaraba/effect-actions/Testing`.

| API                                     | Purpose                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `layer(routes)`                         | A `Layer<HttpClient>` answering requests with `routes` in memory.                   |
| `mcpClient(actions, options?)`          | An Effect of a client calling each action's tool, like `ActionHttp.client`.         |
| `mcpRequest(method, params?, options?)` | One request an `ActionMcp` endpoint serves, answering the response as sent.         |
| `McpCallError`                          | What a client method fails with for an answer it cannot decode; `message` holds it. |

| Option                         | Meaning                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `url`                          | The endpoint, resolved by the `HttpClient` (relative under `layer`); default `/mcp`, the `ActionMcp.layerHttp` default.        |
| `mcpClient`: `transformClient` | Wraps the native `HttpClient`, as `ActionHttp.client` takes it: `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`. |
| `mcpRequest`: `headers`        | Request headers.                                                                                                               |

Exported types: `McpClient<Actions>`, a client's type; `McpClientOptions` of `mcpClient` and `McpRequestOptions` of `mcpRequest`.

`mcpClient(actions, options)` builds a client on the `HttpClient` in context, one method per
action, called as a client method is: `mcp.getUser({ id })`. A method succeeds with the
action's decoded success. It fails with the action's declared errors and the built-in ones as
decoded values, `SchemaError`, `HttpClientError`, or `McpCallError` for any other answer.
Only a tool result carries the action's own errors; any other response decodes only as a
refusal, as authentication and a hook send. The input may be left out when `{}` is a valid
input, sending `{}`, and a given input is sent as given, as for a client's method.

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

### One caller

An implementation's handlers behind its hook, in memory, as one caller: provide the caller
around `layer` instead of authentication, like any other service the routes require, and the
test program shares what it reads.

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

- `layer(routes)` builds the routes with `HttpServer.layerServices` provided and request logging off, and releases them with the layer's scope. What the routes still require is the layer's, as under `HttpRouter.serve`: their builders' services, and any per-request service no middleware of theirs provides. Provide them around it, with `Layer.provideMerge` where the program reads them too, so the handlers and the program share one instance. A per-request service provided there, such as a caller, reaches every request; authentication among the routes still provides its own. Each `layer` builds the routes anew, builders included, unless `Action.layer` built them above it. Requests run in the context the layer is built in, as under `HttpRouter.serve`: a `TestClock` or a reference provided around the program reaches middleware and handlers.
- A relative URL resolves against `http://localhost`, once any `baseUrl` a client adds is applied, so `ActionHttp.client(Http)` needs no `baseUrl` under `layer`, and one given is kept. Every request on this client is answered by the routes, whatever its host, so the native `HttpApiClient` and a remote `ActionCli` command work in memory too.
- A client method sends one stateless `tools/call` for the action's tool, at the protocol version `ActionMcp.layerHttp` serves, 2026-07-28, in both the header and `_meta`. It encodes the input with the action's schema, and decodes the success from `structuredContent.value`, as `ActionHttp.client` does for a route. It reads a JSON or an event-stream response.
- A declared error, the action's own or a built-in one, is a typed failure of its decoded value: an `isError` result from the tool, or a 401 or 403 from the endpoint's authentication or a hook, whose body is the same JSON. Match it with `Effect.catchTag`, exactly as on the HTTP client.
- Any other answer fails with `McpCallError`, whose `message` holds it: another status, the native server's own text (invalid arguments, a defect), no reply, a result without `structuredContent`, or a JSON-RPC error (an unknown tool). Match it with `Effect.catchTag("McpCallError", ...)`.
- The input is typed, so a malformed call cannot be sent through a client method. To assert on a malformed call, another MCP method or the response itself, such as a refusal's status and `WWW-Authenticate` challenge, use `mcpRequest(method, params, options)`.
- `mcpRequest` sends one stateless request as a client method does, with `mcp-name` from `params.name` and the client metadata in `_meta`. A `_meta` in `params`, such as a `progressToken`, is merged over the client metadata, and the protocol version is always the request's own. It succeeds with the response whatever its status.
- A request under `layer` carries the `Host` header of its URL, `localhost` for a relative one, unless it sets its own, so middleware checking the host answers as it would over the network.
- Add `Authorization` through `transformClient`, the same options for `mcpClient` and `ActionHttp.client`: one client per caller, `const alice = { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")) }`. `mcpRequest` takes `headers`.
- A client names each tool by its action and holds no connection. Duplicate action names throw `Duplicate action: <name>`.
- An action no binding holds, such as one served only as a tool, gets a test binding of its own: a binding is plain data. Cover each surface the application exposes.

## Failure modes

- Fails with `Action.Unauthenticated`: the call reached authentication without a valid credential. Give the client a `transformClient` adding it, such as `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`.
- `MCP tools/call "<name>" returned an error: Invalid parameters for tool ...`: the endpoint serves a different contract under that name than the one passed. Call it with the served contract value.
- 404 from a client method: the action's implementation was not passed to any `ActionHttp.layer` call in the served routes, or `baseUrl` adds a path the routes do not have. Include `ActionHttp.layer(Http, implementations)` in the routes.
- The program reads a service the handlers never changed: it was provided inside the routes and again to the program, two instances. Provide it once, around `layer`, with `Layer.provideMerge`.
- Type error that the program still requires an identity, such as `CurrentActor`: a route needs it per request and no authentication among the routes provides it. Provide the authentication around the routes, or the caller around `layer` ([One caller](#one-caller)).
- `MCP tools/call "<name>" answered 404`: the endpoint is not at `/mcp`. Pass its `url`.
- An `HttpClientError` whose reason is `InvalidUrlError`, from a client method on an `HttpClient` other than `layer`'s: a relative `url` resolves only under `layer`. Pass an absolute `url`.
