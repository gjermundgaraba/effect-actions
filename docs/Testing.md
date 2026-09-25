# Testing

In-memory calls against served layers. Needs no extra dependency.

## API

Import `@gjermundgaraba/effect-actions/Testing`.

| API                                  | Purpose                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `serve(routes)`                      | Serve routes in memory: `{ handler, dispose }`.                            |
| `httpClient(Http, server, options?)` | The binding's client, as `ActionHttpClient.make` shapes it, over `server`. |
| `mcpCall(server, options)`           | Call one tool in memory and return its outcome without the wire envelope.  |

`server` is what `serve` returns, or any web handler (`(request) => Promise<Response>`, such as
`HttpRouter.toWebHandler(routes).handler`). `httpClient` takes the binding from
`ActionHttp.make` and `ActionHttpClient.Options`; `baseUrl` defaults to `http://localhost`.

| `mcpCall` option  | Meaning                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `name`            | Required tool name: its action's name.                                                                |
| `arguments`       | Tool arguments; default `{}`.                                                                         |
| `headers`         | Request headers.                                                                                      |
| `path`, `baseUrl` | Where the endpoint is: default `/mcp` (the `ActionMcp.layerHttp` default) against `http://localhost`. |

Exported types: `Server`, `Handler`, `McpCallResult`.

## Canonical

```ts
import { Effect } from "effect";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http, routes } from "./quickstart.js";

const server = Testing.serve(routes);

try {
  const greeting = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* Testing.httpClient(Http, server);

      return yield* client.greet({ name: "Ada" });
    }),
  );

  // One tool call to `/mcp`, answered as `{ isError: false, value: "Hello, Ada!" }`.
  const called = await Testing.mcpCall(server, { name: "greet", arguments: { name: "Ada" } });

  console.log({ greeting, called });
} finally {
  await server.dispose();
}
```

## Rules

- `serve(routes)` is `HttpRouter.toWebHandler` with `HttpServer.layerServices` provided and request logging off. Routes must satisfy their own per-request requirements, with their middleware; a route still owing one is a type error. Each `serve` builds the routes' layers anew, builders included.

- `httpClient` is the client `ActionHttpClient.make` returns, with its transport replaced by `server` and no `HttpClient` requirement. Same calls (`client.greet({ name })`), same error channel. The native client stays available as `HttpApiClient.make(Http.api)`.
- `mcpCall` sends one stateless `tools/call`, pinned to protocol version 2026-07-28 in both the header and `_meta`, and resolves with `{ isError: false, value }`, the success taken from `structuredContent.value`, or `{ isError: true, error }`, the result's error text parsed as JSON. A declared error or a hook refusal is its JSON encoding, the same body HTTP sends; the native server's own messages (invalid arguments, defects) are not JSON and stay text. It reads a JSON or an event-stream response.
- `arguments` accepts what `JSON.stringify` accepts, so tests can send malformed arguments on purpose. `undefined` fields are dropped.
- `mcpCall` throws when the answer is not a tool result, with its status and body: a status other than 200 (an authentication refusal), or a JSON-RPC error (an unknown tool). To assert on other MCP responses, send a `Request` to `server.handler` yourself.
- Add `Authorization` through `headers` in `mcpCall`, or through `transformClient` in `httpClient` options.
- Direct handler tests call the function passed to `Action.implement`, but they bypass decoding, encoding, middleware and the hook. Keep at least one adapter-level test per transport.

## Failure modes

- `MCP tools/call "<name>" answered 401`: the call reached authentication without a credential. Pass `headers: { authorization: "Bearer ..." }`.
- Handler leaks between tests: `dispose()` was not called. Register it with the test runner's cleanup hook.
- 404 from `httpClient`: the action's implementation was not passed to any `ActionHttp.layer` call in the served routes, or the base URL is wrong. Include `ActionHttp.layer(Http, implementations)` in the routes.
- Type error at `serve` naming `HttpRouter.Request<"Requires", ...>`: a route owes a per-request service, such as an identity no middleware provides. Provide the middleware's layer to it.
- 404 from `mcpCall`: the endpoint is not at `/mcp`. Pass its `path`.
