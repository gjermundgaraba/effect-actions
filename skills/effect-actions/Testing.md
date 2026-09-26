# Testing

In-memory calls against served layers, through Effect's own `HttpClient`. Needs no extra
dependency and opens no port.

## API

Import `@gjermundgaraba/effect-actions/Testing`.

| API                | Purpose                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `layer(routes)`    | A `Layer<HttpClient>` answering requests with `routes` in memory.                   |
| `mcpCall(options)` | One tool call on the `HttpClient`, returning its outcome without the wire envelope. |
| `McpCallResult`    | `{ isError: false, value }` or `{ isError: true, error }`.                          |

| `mcpCall` option | Meaning                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `name`           | Required tool name: its action's name.                                                                                  |
| `arguments`      | Tool arguments; default `{}`.                                                                                           |
| `url`            | The endpoint, resolved by the `HttpClient` (relative under `layer`); default `/mcp`, the `ActionMcp.layerHttp` default. |
| `headers`        | Request headers.                                                                                                        |

`mcpCall` is `Effect<McpCallResult, Error, HttpClient>`.

## Canonical

```ts
import { Effect } from "effect";
import * as ActionHttpClient from "@gjermundgaraba/effect-actions/ActionHttpClient";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http, routes } from "./quickstart.js";

const program = Effect.gen(function* () {
  const client = yield* ActionHttpClient.make(Http);
  const greeting = yield* client.greet({ name: "Ada" });

  // One tool call to `/mcp`, answered as `{ isError: false, value: "Hello, Ada!" }`.
  const called = yield* Testing.mcpCall({ name: "greet", arguments: { name: "Ada" } });

  return { greeting, called };
});

// The routes answer in memory for the program's scope, and are released after it.
console.log(await Effect.runPromise(program.pipe(Effect.provide(Testing.layer(routes)))));
```

## Rules

- `layer(routes)` builds the routes with `HttpServer.layerServices` provided and request logging off, and releases them with the layer's scope. Routes must satisfy their own per-request requirements, with their middleware; a route still owing one is a type error. Each `layer` builds the routes anew, builders included.
- A relative URL resolves against `http://localhost`, so `ActionHttpClient.make(Http)` needs no `baseUrl` under `layer`. Every request on this client is answered by the routes, whatever its host, so the native `HttpApiClient` and a remote `ActionCli` command work in memory too.
- `mcpCall` sends one stateless `tools/call`, pinned to protocol version 2026-07-28 in both the header and `_meta`, and succeeds with `{ isError: false, value }`, the success taken from `structuredContent.value`, or `{ isError: true, error }`, the result's error text parsed as JSON. A declared error or a hook refusal is its JSON encoding, the same body HTTP sends; the native server's own messages (invalid arguments, defects) are not JSON and stay text. It reads a JSON or an event-stream response.
- `arguments` accepts JSON values, so tests can send malformed arguments on purpose.
- `mcpCall` fails with an `Error` whose message holds the status and body when the answer is not a tool result: a status other than 200 (an authentication refusal), no reply, or a JSON-RPC error (an unknown tool). To assert on other MCP responses, send a request with `HttpClient` yourself.
- Add `Authorization` through `headers` in `mcpCall`, or through `transformClient` in `ActionHttpClient.make` options.
- Direct handler tests call the function passed to `Action.implement`, but they bypass decoding, encoding, middleware and the hook. Keep at least one test per surface.

## Failure modes

- `MCP tools/call "<name>" answered 401`: the call reached authentication without a credential. Pass `headers: { authorization: "Bearer ..." }`.
- 404 from a client method: the action's implementation was not passed to any `ActionHttp.layer` call in the served routes, or `baseUrl` adds a path the routes do not have. Include `ActionHttp.layer(Http, implementations)` in the routes.
- Type error at `layer` naming `HttpRouter.Request<"Requires", ...>`: a route owes a per-request service, such as an identity no middleware provides. Provide the middleware's layer to it.
- `MCP tools/call "<name>" answered 404`: the endpoint is not at `/mcp`. Pass its `url`.
- An `HttpClientError` whose reason is `InvalidUrlError`, from `mcpCall` on an `HttpClient` other than `layer`'s: a relative `url` resolves only under `layer`. Pass an absolute `url`.
