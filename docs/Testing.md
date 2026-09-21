# Testing

In-memory calls against served layers. `Testing` needs no extra dependency. `TestingClient`
loads the optional `@modelcontextprotocol/client` peer and nothing else does.

## API

```ts
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import * as TestingClient from "@gjermundgaraba/effect-actions/TestingClient";

type Handler = (request: Request) => Promise<Response>; // HttpRouter.toWebHandler(routes).handler

/** Native grouped HttpApiClient calling `handler` in memory. baseUrl defaults to http://localhost. */
const httpClient: <Api extends HttpApi.HttpApi<any, any>>(
  api: Api,
  handler: Handler,
  options?: Parameters<typeof HttpApiClient.make>[1],
) => Effect.Effect<HttpApiClient.Client<Api>>;

/** One stateless 2026-07-28 JSON-RPC request with client metadata defaulted. */
const mcpRequest: (options: McpRequestOptions) => Request;

interface McpRequestOptions {
  readonly url: string | URL;
  readonly method: string; // "tools/list", "tools/call", ...
  readonly params?: McpRequestParams; // anything JSON.stringify accepts, undefined fields included
  readonly headers?: HeadersInit;
}

/** Connect the official client, run the callback, always close the transport. */
const withMcpClient: <A>(
  options: McpClientOptions,
  run: (client: Client) => Promise<A>,
) => Promise<A>;

interface McpClientOptions {
  readonly fetch: (request: Request) => Promise<Response>; // the web handler
  readonly path: string;
  readonly versionNegotiation?: ClientOptions["versionNegotiation"]; // official client default is legacy
  readonly baseUrl?: string | URL; // http://localhost
  readonly headers?: HeadersInit;
}
```

## Canonical

```ts
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import * as TestingClient from "@gjermundgaraba/effect-actions/TestingClient";
import { Http, routes } from "./quickstart.js";

const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)));
// call web.dispose() when the test finishes

// HTTP, typed, in memory.
const greeting = Effect.gen(function* () {
  const client = yield* Testing.httpClient(Http.api, web.handler);

  return yield* client.greetings.greet({ payload: { name: "Ada" } });
});

// MCP, raw request, no handshake (2026-07-28 is stateless).
const listed = await web.handler(
  Testing.mcpRequest({ url: "http://localhost/mcp", method: "tools/list" }),
);

// MCP, official client.
const result = await TestingClient.withMcpClient(
  { fetch: web.handler, path: "/mcp", versionNegotiation: { mode: { pin: "2026-07-28" } } },
  (client) => client.callTool({ name: "greet", arguments: { name: "Ada" } }),
);
```

## Rules

- `httpClient` is the same `HttpApiClient` consumers use, with its transport replaced by `handler`. Same `{ payload }` calls, same error channel.
- `mcpRequest` pins protocol version 2026-07-28 in both the header and `_meta`. Caller `params._meta` fields override the defaulted client capabilities and info; the merge is shallow. Application metadata is preserved.
- `params` accepts what `JSON.stringify` accepts, so tests can send malformed arguments on purpose. `undefined` fields are dropped.
- `withMcpClient` closes the transport in a `finally` block. `versionNegotiation` is passed to the official client unchanged; for a stateless endpoint pin `2026-07-28`.
- Add `Authorization` through `headers` in both MCP helpers, or through `transformClient` in `httpClient` options.
- Direct handler tests can use `app.build` under `Effect.scoped`, but they bypass decoding, encoding, and middleware. Keep at least one adapter-level test per transport.

## Failure modes

- `@modelcontextprotocol/client` not found: only `TestingClient` needs it. Install the peer in devDependencies, or use `Testing.mcpRequest` instead.
- Official client fails negotiation against a stateless endpoint: set `versionNegotiation: { mode: { pin: "2026-07-28" } }`.
- Handler leaks between tests: `web.dispose()` was not called. Register it with the test runner's cleanup hook.
- 404 from `httpClient`: `routes` did not include `Http.layer({}, app)`, or `HttpServer.layerServices` was not provided to `toWebHandler`.
