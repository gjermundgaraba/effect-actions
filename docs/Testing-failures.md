# Testing failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [Testing.md](Testing.md).

- A route answers an empty 500: a defect, or a result that does not encode. `Testing.layer` logs the cause as an error, and nothing for a request that succeeds or is refused: read the test's output, or collect it with a `Logger` or an `ErrorReporter` provided around the layer.
- A client method fails with `Action.Unauthenticated`: routes under `Testing.layer` keep their real authentication. Give the client a credential in `transformClient` ([Test as a signed-in caller](Testing.md#test-as-a-signed-in-caller)).
- A protected route answers 401 where the test expects 415 or 400: authentication runs before the body is read. Send a valid credential.
- `Type 'Provider<CurrentUser, "notes-service.Login">' is missing the following properties from type 'Scope'` at `it.effect`, or `… is not assignable to type 'never'` at `Effect.runPromise`: the routes serve a protected action without a provider of its descriptor. Provide the real one or a test verifier to the routes; a caller provided around `Testing.layer` does not satisfy them.
- `Type 'CurrentUser' is missing the following properties from type 'Scope'` at `it.effect`, or `… is not assignable to type 'never'` at `Effect.runPromise`: the test still owes the identity. An `Action.client` call of a protected action takes its caller per call: provide it around the call. Or a public action's handler reads the identity, which no route provides to it: make the action protected.
- A test passes whatever message an error carries: `toEqual` never compares a tagged error's `message`. Assert it separately ([Assert on errors](Testing.md#assert-on-errors)).
- The test reads a service the handlers never changed: it was provided inside the routes and again to the test, two instances. Provide it once, around `Testing.layer`, with `Layer.provideMerge`.
- `MCP tools/call "<name>" answered 404`: the endpoint is not at `/mcp`, the default. Pass `mcpClient` its `url`.
- `MCP tools/call "<name>" returned an error: Invalid parameters for tool ...`: the endpoint serves another contract under that name. Pass `mcpClient` the served contract value.
- A builder or handler fails with `NotFound: FileSystem.<method> (<path>)` for a file that exists, or a file route answers 500: with no `FileSystem` provided around `Testing.layer`, the routes read a no-op one. Provide `NodeFileSystem.layer` or `NodeServices.layer`. In a command test, the nearer of two provided is read: provide a fake `FileSystem` on the command, inside `NodeServices.layer`.
- `Argument of type 'Layer<…, FileSystem | Generator | HttpPlatform | HttpRouter | Path>' is not assignable` at `HttpRouter.toWebHandler(routes)`: a web handler's routes need the platform services `Testing.layer(routes)` supplies itself. Provide `HttpServer.layerServices` to them.
- `UrlError` from `HttpClientRequest.toWebResult` or `toWeb` of an `mcpRequest`, or an `HttpClientError` whose reason is `InvalidUrlError` from a client method or a sent `mcpRequest`: the `url` is relative, such as the default `/mcp`, which only the `HttpClient` of `Testing.layer` resolves. Pass an absolute one.
