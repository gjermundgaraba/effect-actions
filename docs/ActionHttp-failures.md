# ActionHttp failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [ActionHttp.md](ActionHttp.md).

## Binding and serving

- A route returns 404, which a client method reports as an `HttpClientError` with `DecodeError` or `StatusCodeError`: the path lacks the prefix, no `ActionHttp.layer` call serves the action, or the binding does not hold that very action value, as when a test declares the contract again.
- `Method 'POST' already declared for route '<prefix>/<action>'` when the host builds: two `ActionHttp.layer` calls serve one action; give each layer its own `actions`.
- `Duplicate OpenAPI operationId: <name>` from `OpenApi.fromApi`: two bindings combined into one `HttpApi` share an action name; rename one, or document each binding alone.
- `Type 'Handlers<…>' is not assignable to type '`Endpoint not handled: ${string}`'` at `HttpApiBuilder.group(binding.api, …)`, or `Service not found: effect-actions/Authentication/Security/…` when the host builds: a binding is served with the native `HttpApiBuilder`; serve it with `ActionHttp.layer`.
- `event: effect/http-api/stream/failure` ends an SSE stream: Effect's failure event, an action answering progress or a stream failing after its first event; its `data` is the failure as an encoded `Cause`, which `ActionHttp.client`'s method fails with as declared.
- `Unsupported content-type: <type>` as a 415 body: Effect refuses a `Content-Type` other than `application/json`, after authentication and before the handler; send `application/json`.

## Types

- `Argument of type 'Options<…> | undefined' is not assignable` at `ActionHttp.make`: a helper forwards options that may be absent; pass `options ?? {}`.
- `Type 'X' is not assignable to type 'never'` where the server is launched, or `Request<"Requires", X>` in the layer's type: nothing around the layer provides the request service `X`, or router middleware provides it undeclared; declare it `HttpRouter.middleware<{ provides: X }>()`; the rules are on `ActionHttp.layer`, and where `X` is the identity, on `ActionHttp.LayerOptions.middleware`.
- Type error on `ActionHttp.LayerOptions.middleware` naming `"Layer middleware fails only with the binding's errors and needs no client"`: add the error to the binding's `error`, given inline so its type is certain, or move the check to the handlers and declare the error on their actions.
- `No overload matches this call` at `ActionHttp.client`, naming `Options<unknown, unknown>`: options built before the call hold the generic `HttpClient.mapRequestEffect(authorize)`, or a helper types them as `Parameters<typeof ActionHttp.client>[1]`; write `(client) => HttpClient.mapRequestEffect(client, authorize)`, and type such options as `ActionHttp.ClientOptions<E, R>`.

## Client methods

- `HttpClientError` whose `reason._tag` is `DecodeError`, printed `Decode error (<status> …)`, for a status such as 429: no schema declares that status; declare the error on the binding when middleware answers with it, on the action when its handler does. For a 500, the cause is in the server's logs.
- `HttpClientError` whose `reason._tag` is `InvalidUrlError` outside a browser: relative routes have no page to resolve against; set `baseUrl`.
- Type error listing `HttpClient` as an unsatisfied requirement: provide one, such as `FetchHttpClient.layer`, or use `ActionHttp.fetchClient`.
- `Expected 1 arguments` at a client method: `{}` is not a valid input for the action, so pass its input; where the argument may be omitted, leave it out, as `undefined` is a type error.
- Type error passing `{ payload: ... }` to a client method: `payload` is the native client's shape; pass the input itself.
