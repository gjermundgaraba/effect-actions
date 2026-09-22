# Testing

In-memory calls against served layers. `Testing` needs no extra dependency. `TestingClient`
loads the optional `@modelcontextprotocol/client` peer and nothing else does.

## API

Import `@gjermundgaraba/effect-actions/Testing`; official-client helpers are in the separate
`@gjermundgaraba/effect-actions/TestingClient` subpath.

| API                                          | Purpose                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Testing.httpClient(api, handler, options?)` | Native grouped `HttpApiClient` over an in-memory web handler; retains client middleware requirements. |
| `Testing.mcpRequest(options)`                | Build a stateless MCP JSON-RPC `Request`.                                                             |
| `Testing.mcpCall(handler, options)`          | Call one tool in memory and return its outcome without the wire envelope.                             |
| `TestingClient.withMcpClient(options, run)`  | Connect the official client, run an asynchronous callback, then close it.                             |

`httpClient` takes native client options; `baseUrl` defaults to `http://localhost`.
Its exported `Handler` type is a web request to response Promise.

| MCP option                            | Meaning                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `mcpRequest`: `url`, `method`         | Required destination and JSON-RPC method.                   |
| `mcpRequest`: `params`, `headers`     | Optional parameters and request headers.                    |
| `mcpCall`: `url`, `name`              | Required endpoint URL and tool name (`mcp.name`).           |
| `mcpCall`: `arguments`, `headers`     | Optional tool arguments (default `{}`) and request headers. |
| `withMcpClient`: `fetch`, `path`      | Required in-memory request handler and endpoint path.       |
| `withMcpClient`: `baseUrl`, `headers` | Optional base URL (default `http://localhost`) and headers. |

Exported option/value types: `McpRequestOptions`, `McpRequestParams`, `McpRequestValue`,
`McpCallOptions`, `McpCallResult` from `Testing`, and `McpClientOptions` from `TestingClient`.

## Canonical

```ts
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import * as TestingClient from "@gjermundgaraba/effect-actions/TestingClient";
import { Http, routes } from "./quickstart.js";

const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)));

try {
  const greeting = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* Testing.httpClient(Http.api, web.handler);

      return yield* client.greetings.greet({ payload: { name: "Ada" } });
    }),
  );

  // Raw MCP request; this stateless revision needs no initialize handshake.
  const listed = await web.handler(
    Testing.mcpRequest({ url: "http://localhost/mcp", method: "tools/list" }),
  );

  // One tool call, answered as `{ isError: false, value: "Hello, Ada!" }`.
  const called = await Testing.mcpCall(web.handler, {
    url: "http://localhost/mcp",
    name: "greet",
    arguments: { name: "Ada" },
  });

  // The official client uses the same in-memory handler.
  const result = await TestingClient.withMcpClient({ fetch: web.handler, path: "/mcp" }, (client) =>
    client.callTool({ name: "greet", arguments: { name: "Ada" } }),
  );

  console.log({ greeting, listStatus: listed.status, called, result });
} finally {
  await web.dispose();
}
```

## Rules

- `httpClient` is the same `HttpApiClient` consumers use, with its transport replaced by `handler`. Same `{ payload }` calls, same error channel.
- `mcpRequest` pins protocol version 2026-07-28 in both the header and `_meta`. Caller `params._meta` fields override the defaulted client capabilities and info; the merge is shallow. Application metadata is preserved.
- `params` accepts what `JSON.stringify` accepts, so tests can send malformed arguments on purpose. `undefined` fields are dropped.
- `mcpCall` sends one `tools/call` through `mcpRequest` and resolves with `{ isError: false, value }`, the success taken from `structuredContent.value`, or `{ isError: true, error }`, the result's error text parsed as JSON. A declared error or a hook refusal is its JSON encoding, the same body HTTP sends; the native server's own messages (invalid arguments, defects) are not JSON and stay text. It reads a JSON or an event-stream response.
- `mcpCall` throws when the answer is not a tool result: a status other than 200 (an authentication refusal), or a JSON-RPC error (an unknown tool). Use `mcpRequest` to assert on those responses.
- `withMcpClient` pins the official client to MCP 2026-07-28, the only revision `ActionMcp` serves, and closes the transport in a `finally` block.
- Add `Authorization` through `headers` in the MCP helpers, or through `transformClient` in `httpClient` options.
- Direct handler tests can use `app.build` under `Effect.scoped`, but they bypass decoding, encoding, and middleware. Keep at least one adapter-level test per transport.

## Failure modes

- `@modelcontextprotocol/client` not found: only `TestingClient` needs it. Install the peer in devDependencies, or use `Testing.mcpRequest` instead.
- `withMcpClient` rejects its options with `versionNegotiation`: the revision is fixed at 2026-07-28. Delete the option.
- `MCP tools/call "<name>" answered 401`: the call reached authentication without a credential. Pass `headers: { authorization: "Bearer ..." }`.
- Handler leaks between tests: `web.dispose()` was not called. Register it with the test runner's cleanup hook.
- 404 from `httpClient`: the requested route was not mounted, or the path/base URL is wrong. Include `Http.layer([app])` in the served routes.
- Missing platform-service requirements when constructing the web handler: provide `HttpServer.layerServices` to the routes before `toWebHandler`.
