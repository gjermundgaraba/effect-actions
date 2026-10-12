# Testing

Two ways to test, and neither opens a port. `Action.client` calls an implementation in process:
what its handlers and its `authorize` do. `Testing.layer` answers the real routes in memory,
through Effect's own `HttpClient`: what a surface adds, such as authentication, statuses,
challenges and tool results as sent. The examples put a domain's tests in `test/<domain>/` and
tests of the surfaces beside them, in `it.effect` from `@effect/vitest`, which supplies the
`Scope` that `Action.client` and `ActionRpc.client` require, a `TestClock` and a `TestConsole`.

Read this page alone, in one tool call: pages read together are cut. When something fails,
search [Testing-failures.md](Testing-failures.md). Reading order: [SKILL.md](SKILL.md).

## API

Import `@gjermundgaraba/effect-actions/Testing`.

| API                                     | Purpose                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `layer(routes)`                         | A `Layer<HttpClient>` answering requests with `routes` in memory.             |
| `layer(handler)`                        | A `Layer<HttpClient>` answering requests with a web handler the test serves.  |
| `mcpClient(actions, options?)`          | An Effect of a client calling each action's tool, like `ActionHttp.client`.   |
| `mcpRequest(method, params?, options?)` | One MCP request, as the native `HttpClientRequest` the test sends.            |
| `McpCallError`                          | A client method's failure for an answer it cannot decode; `message` holds it. |

| Option                         | Meaning                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `url`                          | The endpoint; default `/mcp`, the `ActionMcp.layerHttp` default.                |
| `mcpClient`: `transformClient` | Wraps the native `HttpClient`, as `ActionHttp.client` takes it: a bearer token. |
| `mcpRequest`: `headers`        | Request headers.                                                                |

Exported types: `McpClient<Actions>`, `McpClientOptions`, `McpRequestOptions`, and `McpParams`,
the `params` of `mcpRequest`.

## Test an implementation in process

Acquire `Action.client(implementation)` and call its methods
([Action-in-process.md](Action-in-process.md#call-actions-in-process)). A call runs the decoding,
the `authorize` and the handler a server runs, but no authentication and no middleware. Provide
the startup services around the test, as an entrypoint does, and what a request would carry, its
caller first, around each call:

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

See [notes-service/test/notes/notes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/test/notes/notes.test.ts).

- Replace the edge, not the service under test:
  [mcp-tools/test/printers/printers.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/mcp-tools/test/printers/printers.test.ts)
  runs the real upstream service over a fake `HttpClient` Layer.
- `it.effect` runs on a test clock: fork a call that waits, `TestClock.adjust`, then join it.
- A stdio server runs the same implementations: test them here. A subprocess test adds only what
  the process adds, stdout carrying nothing but the protocol.
- A Toolkit and a CLI need no `Testing` export: call `toolkit.handle` or script a
  `LanguageModel` ([assistant/test/toolkit.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/test/toolkit.test.ts)),
  and run commands with `Command.runWith`
  ([assistant/test/commands.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/test/commands.test.ts)).

## Test routes in memory

Export the routes still requiring what an entrypoint chooses, give the test its own, and provide
the layer to each test:

```ts
const served = Testing.layer(routes).pipe(Layer.provide(NoteStore.layerMemory));
```

Under it, `ActionHttp.client(Http)` needs no `baseUrl`, and `HttpClient.get("/healthz")` reaches
the host's own routes. Each test builds the routes anew, so each starts from an empty store. See
[notes-service/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/notes-service/test/routes.test.ts); the smallest
test is
[quickstart/test/greeting/greeting.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/quickstart/test/greeting/greeting.test.ts).

- A service the test reads too goes around `layer` with `Layer.provideMerge`, so handlers and
  test share one instance
  ([kitchen-sink/test/identity/session.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/identity/session.test.ts)).
- Two `layer`s are two servers: a second one runs every builder again, and they share only what
  is provided around both. For two ports, that is `Action.layer(implementations)` and the
  services ([kitchen-sink/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/routes.test.ts),
  [Action-in-process.md](Action-in-process.md#share-one-build-across-servers)).
- The client is `layer`'s own. A fake upstream is another `HttpClient`: provide it to the service
  that calls out ([mcp-tools/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/mcp-tools/test/routes.test.ts)).
- Every request on `layer`'s client reaches the routes, whatever its host: a client given a
  `baseUrl`, a remote `ActionCli` command's included, runs in memory unchanged.
- Requests run in the test's context: a `ConfigProvider` or the test clock around the test
  reaches middleware and handlers.
- To send raw web `Request`s too, build one `HttpRouter.toWebHandler` and dispose it yourself;
  `Testing.layer(web.handler)` gives the typed clients the same handler
  ([kitchen-sink/test/request-policy.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/request-policy.test.ts)).

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

- Never provide the identity to `layer`, around it or to the routes. It is a type error: only a
  provider of their own descriptor satisfies them.
- To change what a credential verifies as, replace the service the verifier reads (`servedWith`
  in
  [kitchen-sink/test/identity/identity.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/identity/identity.test.ts)),
  or provide a test verifier: another `Authentication.layer` of the same descriptor.

A typed client decodes a refusal to its error. To assert on the answer as sent, build the request
(`HttpClientRequest.post`, `bearerToken`, `bodyJsonUnsafe`) and send it with `HttpClient.execute`,
which succeeds whatever the status. Read `response.status` and
`response.headers["www-authenticate"]`, the challenge, as that file does. The status and body of
each case are the table in [guarantees.md](guarantees.md#wire-behavior).

## Test MCP tools

`Testing.mcpClient(actions, options?)` gives one method per action, calling its tool and decoding
the result as `ActionHttp.client` decodes a route's, an image included. Pass the contract values
the endpoint serves, such as `implementation.actions`.

A method fails with the action's declared errors and the built-in ones as decoded values, and with
`McpCallError` for any other answer. Only a tool's result carries the action's own errors: an HTTP
answer other than 200 decodes as a refusal alone, so an error a verifier declares, typed over
`ActionHttp.client`, is an `McpCallError` here
([kitchen-sink/test/identity/identity.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/identity/identity.test.ts)).

A method decodes a refusal alike whether the endpoint answered a 401 or a 403 or returned a tool
result in a 200 ([guarantees.md](guarantees.md#wire-behavior)): to assert which, send the call
yourself and read its status.

For that, and for what the client's types will not send or its decoding hides (`tools/list`, an
`Origin` header, a refusal's challenge, a malformed call), build the request with
`Testing.mcpRequest`. It returns a native `HttpClientRequest`:
`yield* HttpClient.execute(Testing.mcpRequest("tools/call", { name: "whoAmI", arguments: {} }))`
succeeds with the response whatever its status, to read `response.status`, `response.headers`
and `yield* response.json`
([kitchen-sink/test/identity/identity.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/test/identity/identity.test.ts)
asserts a 401 so, and
[mcp-tools/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/mcp-tools/test/routes.test.ts) reads `tools/list`).
For a web handler or `fetch`, pass an absolute `url`: `HttpClientRequest.toWebResult(request)` is
then a `Result` holding the web `Request`, taken with `Result.getOrThrow`.

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
[live-rpc/test/routes.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/test/routes.test.ts);
[live-rpc/test/browser.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/test/browser.test.ts) tests a page's client
the same way. Effect's `RpcTest.makeClient` is no substitute: it asks for handlers of the
binding's group, which `ActionRpc.layer` does not provide (`Handler<"…">` stays required).

## Assert on errors

Take the failure with `Effect.flip(call)`, which alone asserts only that the call failed, then
assert its class and its `message` separately:

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
([assistant/test/toolkit.test.ts](node_modules/@gjermundgaraba/effect-actions/examples/assistant/test/toolkit.test.ts)).
