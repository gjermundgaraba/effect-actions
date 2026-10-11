# ActionHttp failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [ActionHttp.md](ActionHttp.md).

## Binding and serving

- Route returns 404: the action is not in the binding, no `layer` call serves it, or the path
  lacks the prefix. An action is served only if the binding holds that very value: a test
  declaring the contract again has made another.
- `No action of these implementations is in this HTTP binding: x` thrown by `layer`: these are
  the wrong implementations, or it is the wrong binding. `x (another contract)` is an action of a
  bound name that is not the bound value, as a second copy of the contracts module makes.
- `Listed in actions, but the binding does not hold it: <names>`, or
  `but no implementation holds it`, thrown by `layer`: a listed action is not among the binding's
  or the implementations', by identity.
- `Duplicate served action: <name>` thrown by `layer`: one call received two implementations of
  the same bound action.
- `Method 'POST' already declared for route '<prefix>/<action>'` when the host builds: two `layer`
  calls serve the same action. Give each layer its own `actions`.
- `Duplicate middleware: <key>` thrown by `layer`: `middleware` lists one middleware twice.
- `Duplicate action: <name>` thrown by `make`: two actions share a name, or one is listed twice.
  Rename one, or bind it under another prefix.
- `ActionHttp binding: error _tag "Forbidden" is built in, and declared on every surface` thrown by
  `make`: a binding error is a built-in error or reuses its tag. Drop it, or rename your own.
- `Duplicate OpenAPI operationId: <name>` from `OpenApi.fromApi` on a combined API: two combined
  bindings have an action of that name. Rename one, or document each binding on its own.
- A combined document or native client lacks one binding's actions: the two share a prefix, so
  one group replaced the other. Give each its own prefix.
- `Service not found: effect-actions/Authentication/Security/…` when the host builds: a binding
  holding a protected action is served with the native `HttpApiBuilder`. Serve it with `layer`.
- Swagger shows no Authorize button: the binding holds no protected action.

## Types

- `No overload matches this call` at `make`, naming
  `"Protected actions take options naming their authentication"`, or a type error naming
  `authentication`: give `{ authentication: Login }`. Do not silence it with
  `caller: Action.Anyone` ([Authentication.md](Authentication-failures.md)).
- `Argument of type 'Options<…> | undefined' is not assignable` at `make`: a helper forwards
  options that may be absent. Pass `options ?? {}`.
- `Provider<…>` among the layer's requirements, or
  `Type 'Provider<...>' is not assignable to type 'never'` where the server is launched: provide
  the descriptor's provider ([Authentication.md](Authentication-failures.md)).
- `Authentication "<name>": the binding's descriptor is not its provider's`, a defect when `layer`
  builds: build the binding and its provider from one descriptor.
- `Type 'X' is not assignable to type 'never'` where the server is launched, or
  `Request<"Requires", X>` in the layer's type: a handler, an authorizer or a layer middleware
  reads a request service `X` that nothing around the layer provides
  ([Serve the routes](ActionHttp.md#serve-the-routes)). Where `X` is the identity, a public handler reads it or
  a layer middleware requires it on a layer serving public actions: make the action protected, or
  serve the protected actions from a layer of their own.
- A type error on `middleware` naming
  `"Layer middleware fails only with the binding's errors and needs no client"`: add the error to
  the binding's `error`, given inline so its type is certain, or move the check to the handlers
  and declare the error on their actions.

## Requests

- A route answers without credentials: its contract is `caller: Action.Anyone`.
- A protected route answers 401 to a request with a missing content type or invalid input:
  authentication runs before anything reads the body. Send the token first.
- 400 `InvalidInput` on a valid-looking request: its `message` names each field that did not
  decode, or that the action does not declare, such as a misspelling. An action without input
  takes only `{}`, and needs a body.
- 415 `Unsupported content-type: <type>` (`none` without one): the request is not typed as JSON,
  such as `fetch`'s default `text/plain` for a string body. Send `Content-Type: application/json`.
- Empty 500: a defect, or a handler result that does not match the success schema. The cause is
  in the server's logs.

## Client methods

- `HttpClientError` whose `reason._tag` is `DecodeError`, for a status such as 429: no schema
  declares that status. Declare the error on the binding when middleware answers with it, or on
  the action when its handler does.
- `HttpClientError` with `DecodeError` or `StatusCodeError` and a 404: no layer serves that action.
- `HttpClientError` whose `reason._tag` is `InvalidUrlError` outside a browser: there is no page
  to resolve relative routes against. Set `baseUrl`.
- Type error listing `HttpClient` as an unsatisfied requirement: provide one, such as
  `FetchHttpClient.layer`, or use `fetchClient`.
- Property does not exist on the client: the action is not in the binding.
- `Expected 1 arguments`: `{}` is not a valid input for the action, so it needs its input.
- Type error passing `undefined` to a method whose argument may be omitted: leave it out.
- Type error passing `{ payload: ... }`: that is the native client's shape. Pass the input itself.
- `InvalidInput` `Expected Filters` given a plain object: the input is a class, which encodes
  only its instances. Pass `new Filters({ ... })`.
- Type error passing `transformResponse`: it could change what a method returns. Use
  `transformClient`, or the native client.
