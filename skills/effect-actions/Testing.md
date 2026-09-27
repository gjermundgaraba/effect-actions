# Testing

In-memory calls against served layers, through Effect's own `HttpClient`. Needs no extra
dependency and opens no port.

## API

Import `@gjermundgaraba/effect-actions/Testing`.

| API                                 | Purpose                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `layer(routes)`                     | A `Layer<HttpClient>` answering requests with `routes` in memory.          |
| `mcpCall(action, input?, options?)` | One tool call on the `HttpClient`, typed by its action like a client call. |

| `mcpCall` option | Meaning                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `url`            | The endpoint, resolved by the `HttpClient` (relative under `layer`); default `/mcp`, the `ActionMcp.layerHttp` default. |
| `headers`        | Request headers.                                                                                                        |

`mcpCall(action, input)` succeeds with the action's decoded success. It fails with the
action's declared errors and the refusals as decoded values, `SchemaError`,
`HttpClientError`, or an `Error` for any other answer. Only a tool result carries the
action's own errors; any other response decodes only as a refusal, as authentication sends. It requires an `HttpClient`. The input
may be left out when `{}` is a valid input.

## Canonical

```ts
import { Effect } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Greet, Http, routes } from "./quickstart.js";

const program = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http);
  const greeting = yield* client.greet({ name: "Ada" });

  // The same action as one tool call to `/mcp`, typed like the client's method.
  const called = yield* Testing.mcpCall(Greet, { name: "Ada" });

  return { greeting, called };
});

// The routes answer in memory for the program's scope, and are released after it.
console.log(await Effect.runPromise(program.pipe(Effect.provide(Testing.layer(routes)))));
```

## Rules

- `layer(routes)` builds the routes with `HttpServer.layerServices` provided and request logging off, and releases them with the layer's scope. Routes must satisfy their own per-request requirements, with their middleware; a route still owing one is a type error. Each `layer` builds the routes anew, builders included.
- A relative URL resolves against `http://localhost`, once any `baseUrl` a client adds is applied, so `ActionHttp.client(Http)` needs no `baseUrl` under `layer`, and one given is kept. Every request on this client is answered by the routes, whatever its host, so the native `HttpApiClient` and a remote `ActionCli` command work in memory too.
- `mcpCall` sends one stateless `tools/call` for the action's tool, pinned to protocol version 2026-07-28 in both the header and `_meta`. It encodes the input with the action's schema, and decodes the success from `structuredContent.value`, as `ActionHttp.client` does for a route. It reads a JSON or an event-stream response.
- A declared error, the action's own or a refusal, is a typed failure of its decoded value: an `isError` result from the tool, or a 401 or 403 from the endpoint's authentication, whose body is the same JSON. Match it with `Effect.catchTag`, exactly as on the HTTP client.
- Any other answer fails with an `Error` whose message holds it: another status, the native server's own text (invalid arguments, a defect), no reply, or a JSON-RPC error (an unknown tool).
- The input is typed, so a malformed call cannot be sent through `mcpCall`. To assert on a malformed request or another MCP response, send the request with `HttpClient` yourself.
- Add `Authorization` through `headers` in `mcpCall`, or through `transformClient` in `ActionHttp.client` options.
- Direct handler tests call the function passed to `Action.implement`, but they bypass decoding, encoding, authentication and the hook. Keep at least one test per surface.

## Failure modes

- Fails with `Action.Unauthenticated`: the call reached authentication without a valid credential. Pass `headers: { authorization: "Bearer ..." }`.
- `MCP tools/call "<name>" returned an error: Invalid parameters for tool ...`: the endpoint serves a different contract under that name than the one passed. Call it with the served contract value.
- 404 from a client method: the action's implementation was not passed to any `ActionHttp.layer` call in the served routes, or `baseUrl` adds a path the routes do not have. Include `ActionHttp.layer(Http, implementations)` in the routes.
- Type error at `layer` naming `HttpRouter.Request<"Requires", ...>`: a route owes a per-request service, such as an identity no authentication around it provides. Provide the authentication, or other middleware for the service, around the routes.
- `MCP tools/call "<name>" answered 404`: the endpoint is not at `/mcp`. Pass its `url`.
- An `HttpClientError` whose reason is `InvalidUrlError`, from `mcpCall` on an `HttpClient` other than `layer`'s: a relative `url` resolves only under `layer`. Pass an absolute `url`.
