# Testing

Two ways to test, and neither opens a port. `Action.client` calls an implementation in process:
what its handlers and its `authorize` do. `Testing.layer` answers the real routes in memory,
through Effect's own `HttpClient`: what a surface adds, such as authentication, statuses,
challenges and tool results as sent. The examples put a domain's tests in `test/<domain>/` and tests of
the surfaces beside them. They use `it.effect` from `@effect/vitest`, which supplies the `Scope`
that `Action.client` and `ActionRpc.client` require, a `TestClock` and a `TestConsole`.

## API

Import `@gjermundgaraba/effect-actions/Testing`.

| API                                     | Purpose                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `layer(routes)`                         | A `Layer<HttpClient>` answering requests with `routes` in memory.                   |
| `layer(handler)`                        | A `Layer<HttpClient>` answering requests with a web handler the test serves.        |
| `mcpClient(actions, options?)`          | An Effect of a client calling each action's tool, like `ActionHttp.client`.         |
| `mcpRequest(method, params?, options?)` | One request an `ActionMcp` endpoint serves, as the native request the test sends.   |
| `McpCallError`                          | What a client method fails with for an answer it cannot decode; `message` holds it. |

| Option                         | Meaning                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `url`                          | The endpoint; default `/mcp`, the `ActionMcp.layerHttp` default.                |
| `mcpClient`: `transformClient` | Wraps the native `HttpClient`, as `ActionHttp.client` takes it: a bearer token. |
| `mcpRequest`: `headers`        | Request headers.                                                                |

Exported types: `McpClient<Actions>`, `McpClientOptions`, `McpRequestOptions`, and `McpParams`, the `params` of `mcpRequest`.

## Test an implementation in process

Acquire `Action.client(implementation)` and call its methods
([Action.md](Action.md#call-actions-in-process)). A call runs the decoding, the `authorize` and
the handler a server runs, but no authentication and no middleware. Provide the startup services
around the test, as an entrypoint does, and what a request would carry, its caller first, around
each call:

```ts
const as = (user: keyof typeof users) => Effect.provideService(CurrentUser, users[user]);

it.effect("keeps each user's notes their own", () =>
  Effect.gen(function* () {
    const client = yield* Action.client(notes);
    const note = yield* client.createNote({ title: "Plan", body: "Draft" }).pipe(as("ada"));

    expect(yield* client.listNotes().pipe(as("grace"))).toEqual({ notes: [] });
  }).pipe(Effect.provide(NoteStore.layerMemory)),
);
```

See [notes-service/test/notes/notes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/test/notes/notes.test.ts).

- Replace the edge, not the service under test: [mcp-tools/test/printers/printers.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/test/printers/printers.test.ts) runs the real upstream service over a fake `HttpClient` Layer.
- `it.effect` runs on a test clock: fork a call that waits, `TestClock.adjust`, then join it.
- A Toolkit and a CLI need no `Testing` export: call `toolkit.handle` or script a `LanguageModel` ([assistant/test/toolkit.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/test/toolkit.test.ts)), and run commands with `Command.runWith` ([assistant/test/commands.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/test/commands.test.ts)).

## Test routes in memory

Export the routes still requiring what an entrypoint chooses, give the test its own, and provide
the layer to each test:

```ts
const served = Testing.layer(routes).pipe(Layer.provide(NoteStore.layerMemory));
```

Under it, `ActionHttp.client(Http)` needs no `baseUrl`, and `HttpClient.get("/healthz")` reaches the
host's own routes. Each test builds the routes anew, so each starts from an empty store. See
[notes-service/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/test/routes.test.ts).

- A service the test reads too goes around `layer` with `Layer.provideMerge`, so handlers and test share one instance ([kitchen-sink/test/identity/session.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/session.test.ts)).
- Two `layer`s are two servers. Each builds its routes in a layer graph of its own, so a second one runs every builder again and shares only what is provided around both: for two ports, `Action.layer(implementations)` and the services ([kitchen-sink/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/routes.test.ts), [Action.md](Action.md#share-one-build-across-servers)).
- The client is `layer`'s own. A fake upstream is another `HttpClient`: provide it to the service that calls out ([mcp-tools/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/test/routes.test.ts)).
- Every request on `layer`'s client reaches the routes, whatever its host, and carries that host as its `Host` header, `localhost` for a relative URL: a client given a `baseUrl` and a remote `ActionCli` command run in memory unchanged.
- Requests run in the test's context: a `ConfigProvider` or the test clock around the test reaches middleware and handlers.
- To send raw web `Request`s too, build one `HttpRouter.toWebHandler` and dispose it yourself; `Testing.layer(web.handler)` gives the typed clients the same handler ([kitchen-sink/test/request-policy.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/request-policy.test.ts)).

## Test as a signed-in caller

The routes keep their real authentication. Serve them behind their provider
([Authentication.md](Authentication.md#verify-credentials)), and give each client its caller's
credential:

```ts
const as = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});
```

Both clients take it: `ActionHttp.client(Http, as("reader"))` and
`Testing.mcpClient([GetStatus, ...Notes], as("ada"))`.

- Never provide the identity to `layer`, around it or to the routes. It is a type error: only a provider of their own descriptor satisfies them.
- To change what a credential verifies as, replace the service the verifier reads (`servedWith` in [kitchen-sink/test/identity/identity.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/identity.test.ts)), or provide a test verifier: another `Authentication.layer` of the same descriptor.

A typed client decodes a refusal to its error. To assert on the answer as sent, build the request
and send it with `HttpClient.execute`, which succeeds whatever the status:

```ts
const send = HttpClientRequest.post("/api/createNote").pipe(
  HttpClientRequest.bearerToken("reader"),
  HttpClientRequest.bodyJsonUnsafe({ title: "Plan", body: "" }),
  HttpClient.execute,
);
```

Yield it and read `response.status`, 403 here, and `response.headers["www-authenticate"]`, the
challenge
([kitchen-sink/test/identity/identity.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/identity.test.ts)).

## Test MCP tools

`Testing.mcpClient(actions, options?)` gives one method per action, calling its tool and decoding
the result as `ActionHttp.client` decodes a route's, an image included. Pass the contract values
the endpoint serves, such as `implementation.actions`.

A method fails with the action's declared errors and the built-in ones as decoded values, and with
`McpCallError` for any other answer. Only a tool's result carries the action's own errors: an HTTP
answer other than 200 decodes as a refusal alone, so an error a verifier declares, typed over
`ActionHttp.client`, is an `McpCallError` here
([kitchen-sink/test/identity/identity.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/identity.test.ts)).

For what the client's types will not send or its decoding hides (`tools/list`, an `Origin` header,
a refusal's challenge, a malformed call), send `Testing.mcpRequest`. It is a native
`HttpClientRequest`: `HttpClient.execute(Testing.mcpRequest("tools/list"))` succeeds with the
response whatever its status
([mcp-tools/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/test/routes.test.ts)). For a web handler or
`fetch`, convert it with `HttpClientRequest.toWebResult` and pass an absolute `url`.

## Test rpcs

`Testing.layer` answers HTTP requests and cannot upgrade a WebSocket. Export the rpc layer without
its protocol ([ActionRpc.md](ActionRpc.md#serve-the-rpcs)), and give it Effect's HTTP protocol in
the test, on both sides:

```ts
const server = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);

const served = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Testing.layer(server)),
  Layer.provide(MessageStore.layerMemory),
);

const as = (token: string) => RpcClient.withHeaders({ authorization: `Bearer ${token}` });
```

Authentication is per message, so each call carries its credential and one client serves every
caller: `client.postMessage({ text }).pipe(as("ada"))`. See
[live-rpc/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/live-rpc/test/routes.test.ts). Effect's
`RpcTest.makeClient` is no substitute: it asks for handlers of the binding's group, which
`ActionRpc.layer` does not provide (`Handler<"…">` stays required), so it reaches none of the
library's authentication, decoding or `authorize`.

## Assert on errors

Take the failure with `Effect.flip(call)`, then assert its class and its `message` separately:

```ts
expect(refusal).toBeInstanceOf(Action.Forbidden);
expect(refusal.message).toBe("Requires notes:write.");
```

`toEqual` never compares a tagged error's `message`, which is not an enumerable property:
`expect(error).toEqual(new Action.Forbidden({ message: "anything" }))` passes for every message,
and so does `toStrictEqual`. Other fields are compared, so `toEqual(new NoteNotFound({ id }))`
asserts the `id`, and `toEqual(new Action.Forbidden({ scopes: ["issues:write"] }))` still needs the
message asserted beside it. The message is all a model reads of a tool's failure.

A Toolkit raises neither a refusal nor a declared error: each is a result the model reads, so
assert `isFailure` and `result.message`
([assistant/test/toolkit.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/test/toolkit.test.ts)).

## Examples

| File                                                                                                   | Shows                                                             |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [quickstart/test/greeting/greeting.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/quickstart/test/greeting/greeting.test.ts)     | The smallest test: one action over HTTP and as a tool.            |
| [notes-service/test/notes/notes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/test/notes/notes.test.ts)           | An implementation in process, a caller per call.                  |
| [notes-service/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/notes-service/test/routes.test.ts)                     | Routes and tools behind their authentication, a token per client. |
| [mcp-tools/test/printers/printers.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/test/printers/printers.test.ts)       | A fake upstream as a Layer, `TestClock` for a timeout.            |
| [mcp-tools/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/mcp-tools/test/routes.test.ts)                             | `tools/list` as sent, an image decoded, an `Origin` header.       |
| [assistant/test/toolkit.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/test/toolkit.test.ts)                           | A Toolkit's calls by hand and through a scripted model.           |
| [assistant/test/commands.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/test/commands.test.ts)                         | Commands run with arguments and stdin, their output read.         |
| [assistant/test/tasks/store.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/assistant/test/tasks/store.test.ts)                   | A file store on a temporary path, set through a `ConfigProvider`. |
| [live-rpc/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/live-rpc/test/routes.test.ts)                               | Rpcs over the HTTP protocol, a token per call.                    |
| [live-rpc/test/browser.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/live-rpc/test/browser.test.ts)                             | A page's RPC client under the same protocol.                      |
| [kitchen-sink/test/routes.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/routes.test.ts)                       | Two ports as two `layer`s over shared builders and services.      |
| [kitchen-sink/test/request-policy.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/request-policy.test.ts)       | `layer(handler)`, raw `Request`s to a web handler.                |
| [kitchen-sink/test/identity/identity.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/identity.test.ts) | A replaced verifier service, a challenge as sent, `McpCallError`. |
| [kitchen-sink/test/identity/session.test.ts](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/test/identity/session.test.ts)   | A cookie per rpc call, one quota spent across HTTP and RPC.       |

[kitchen-sink/README.md](https://github.com/gjermundgaraba/effect-actions/blob/main/examples/kitchen-sink/README.md#index) maps every export and option to a file.

## Failure modes

- Fails with `Action.Unauthenticated`: the client sent no valid credential. Give it a `transformClient` ([Test as a signed-in caller](#test-as-a-signed-in-caller)).
- A protected route answers 401 where the test expects a 415 or a 400: authentication runs before the body is read. Send a valid credential.
- `Type 'Provider<CurrentUser, "notes-service.Login">' is missing the following properties from type 'Scope'` at `it.effect`, or `… is not assignable to type 'never'` at `Effect.runPromise`: the routes serve a protected action without a provider of its descriptor. Provide the real one or a test verifier to the routes. A caller provided around `layer` does not satisfy it.
- `Type 'CurrentUser' is missing the following properties from type 'Scope'` at `it.effect`, or `… is not assignable to type 'never'` at `Effect.runPromise`: a public action's handler reads the identity, which no route provides it. Make the action protected.
- A test passes whatever message an error carries: see [Assert on errors](#assert-on-errors).
- The test reads a service the handlers never changed: it was provided inside the routes and again to the test, two instances. Provide it once, around `layer`, with `Layer.provideMerge`.
- 404 from a client method: the action's implementation was not passed to any `ActionHttp.layer` of its binding in the served routes, or `baseUrl` adds a path the routes do not have.
- `MCP tools/call "<name>" answered 404`: the endpoint is not at `/mcp`. Pass its `url`.
- `MCP tools/call "<name>" returned an error: Invalid parameters for tool ...`: the endpoint serves another contract under that name. Pass the served contract value.
- `Duplicate action: <name>` thrown by `mcpClient`: two of the actions passed share a name.
- A builder or handler fails with `NotFound: FileSystem.<method> (<path>)` for a file that exists, or a file route answers 500: nothing provided a `FileSystem` around `layer`, so the routes read a no-op one. Provide `NodeFileSystem.layer` or `NodeServices.layer` around it.
- `Argument of type 'Layer<…, FileSystem | Generator | HttpPlatform | HttpRouter | Path>' is not assignable` at `HttpRouter.toWebHandler(routes)`, then `No overload matches this call` at `layer(web.handler)`: a web handler's routes need the platform services `layer(routes)` supplies itself. Provide `HttpServer.layerServices` to them.
- `HttpClientRequest.toWebResult` or `toWeb` of an `mcpRequest` fails with `UrlError`: its `url` is the relative default. Pass an absolute one.
- An `HttpClientError` whose reason is `InvalidUrlError`, from a client method or a sent `mcpRequest`: the `HttpClient` is not `layer`'s and prepends no base URL, so a relative `url` does not resolve. Pass an absolute one.
