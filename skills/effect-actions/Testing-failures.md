# Testing failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [Testing.md](Testing.md).

- Fails with `Action.Unauthenticated`: the client sent no valid credential. Give it a `transformClient` ([Test as a signed-in caller](Testing.md#test-as-a-signed-in-caller)).
- A protected route answers 401 where the test expects a 415 or a 400: authentication runs before the body is read. Send a valid credential.
- `Type 'Provider<CurrentUser, "notes-service.Login">' is missing the following properties from type 'Scope'` at `it.effect`, or `… is not assignable to type 'never'` at `Effect.runPromise`: the routes serve a protected action without a provider of its descriptor. Provide the real one or a test verifier to the routes. A caller provided around `layer` does not satisfy it.
- `Type 'CurrentUser' is missing the following properties from type 'Scope'` at `it.effect`, or `… is not assignable to type 'never'` at `Effect.runPromise`: a public action's handler reads the identity, which no route provides it. Make the action protected.
- A test passes whatever message an error carries: see [Assert on errors](Testing.md#assert-on-errors).
- The test reads a service the handlers never changed: it was provided inside the routes and again to the test, two instances. Provide it once, around `layer`, with `Layer.provideMerge`.
- 404 from a client method: the action's implementation was not passed to any `ActionHttp.layer` of its binding in the served routes, or `baseUrl` adds a path the routes do not have.
- `MCP tools/call "<name>" answered 404`: the endpoint is not at `/mcp`. Pass its `url`.
- `MCP tools/call "<name>" returned an error: Invalid parameters for tool ...`: the endpoint serves another contract under that name. Pass the served contract value.
- `Duplicate action: <name>` thrown by `mcpClient`: two of the actions passed share a name.
- A builder or handler fails with `NotFound: FileSystem.<method> (<path>)` for a file that exists, or a file route answers 500: nothing provided a `FileSystem` around `layer`, so the routes read a no-op one. Provide `NodeFileSystem.layer` or `NodeServices.layer` around it.
- `Argument of type 'Layer<…, FileSystem | Generator | HttpPlatform | HttpRouter | Path>' is not assignable` at `HttpRouter.toWebHandler(routes)`, then `No overload matches this call` at `layer(web.handler)`: a web handler's routes need the platform services `layer(routes)` supplies itself. Provide `HttpServer.layerServices` to them.
- `HttpClientRequest.toWebResult` or `toWeb` of an `mcpRequest` fails with `UrlError`: its `url` is the relative default. Pass an absolute one.
- An `HttpClientError` whose reason is `InvalidUrlError`, from a client method or a sent `mcpRequest`: the `HttpClient` is not `layer`'s and prepends no base URL, so a relative `url` does not resolve. Pass an absolute one.
