# ActionHttp failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [ActionHttp.md](ActionHttp.md).

## Binding and serving

- A route returns 404, which a client method reports as an `HttpClientError` with `DecodeError`
  or `StatusCodeError`: the path lacks the prefix, no `layer` call serves the action, or the
  binding does not hold that very action value, as when a test declares the contract again.
- `No action of these implementations is in this HTTP binding: x`,
  `Listed in actions, but the binding does not hold it: <names>` or
  `but no implementation holds it`, thrown by `layer`: the binding, the implementations and
  `actions` are matched by action value, never by name. `x (another contract)` is an action of a
  bound name that is not the bound value, as a second copy of the contracts module makes.
- `Duplicate served action: <name>` thrown by `layer`, or
  `Method 'POST' already declared for route '<prefix>/<action>'` when the host builds: an action
  is served once. One `layer` call got two implementations of it, or two calls serve it: give
  each layer its own `actions`.
- `Duplicate action: <name>` thrown by `make`: two actions share a name, or one is listed twice.
  Rename one, or bind it under another prefix.
- `Duplicate OpenAPI operationId: <name>` from `OpenApi.fromApi`, or a combined document or
  native client lacking one binding's actions: bindings combined into one `HttpApi` need distinct
  action names and distinct prefixes. Rename or re-prefix one, or document each binding alone.
- `Service not found: effect-actions/Authentication/Security/…` when the host builds: a binding
  holding a protected action is served with the native `HttpApiBuilder`. Serve it with `layer`.
- Swagger shows no Authorize button: the binding holds no protected action.

## Types

- `No overload matches this call` at `make`, naming
  `"Protected actions take options naming their authentication"`, or a type error naming
  `authentication`: give `{ authentication: Login }`. Do not silence it with
  `caller: Action.Anyone`.
- `Argument of type 'Options<…> | undefined' is not assignable` at `make`: a helper forwards
  options that may be absent. Pass `options ?? {}`.
- `Provider<…>` among the layer's requirements, or
  `Type 'Provider<...>' is not assignable to type 'never'` where the server is launched: provide
  the descriptor's provider ([Authentication-failures.md](Authentication-failures.md)).
- `Authentication "<name>": the binding's descriptor is not its provider's`, a defect when `layer`
  builds: build the binding and its provider from one descriptor.
- `Type 'X' is not assignable to type 'never'` where the server is launched, or
  `Request<"Requires", X>` in the layer's type: a handler, an authorizer or a layer middleware
  reads a request service `X` that nothing around the layer provides, or router middleware
  provides `X` and is not declared `HttpRouter.middleware<{ provides: X }>()`
  ([Serve the routes](ActionHttp.md#serve-the-routes)). Where `X` is the identity, a public
  handler reads it, or a layer whose middleware requires it serves public actions: make the
  action protected, or serve the protected actions from a layer of their own.
- Type error on `middleware` naming
  `"Layer middleware fails only with the binding's errors and needs no client"`: add the error to
  the binding's `error`, given inline so its type is certain, or move the check to the handlers
  and declare the error on their actions.

- `No overload matches this call` at `client`, naming `Options<unknown, unknown>`: options built
  before the call hold the generic `HttpClient.mapRequestEffect(authorize)`, whose failures the
  call cannot infer, or a helper types them as `Parameters<typeof ActionHttp.client>[1]`. Write
  the transform as `(client) => HttpClient.mapRequestEffect(client, authorize)`, and type such
  options as `ActionHttp.ClientOptions<E, R>`.

## Requests

- A route answers without credentials: its contract is `caller: Action.Anyone`.
- A protected route answers 401 to a request with no content type or invalid input:
  authentication runs before the body is read. Send the token.
- 400 `InvalidInput` on a valid-looking request: its `message` names each field that did not
  decode or the action does not declare, such as a misspelling. An action without input takes
  only `{}`, and needs a body.
- 415 `Unsupported content-type: <type>` (`none` without one): the request is not typed as JSON,
  such as `fetch`'s default `text/plain` for a string body. Send `Content-Type: application/json`.
- Empty 500: a defect, or a handler result not matching the success schema. The cause is in the
  server's logs, written by its request logger, and under `Testing.layer` in the test's, as an error.

## Client methods

- `HttpClientError` whose `reason._tag` is `DecodeError`, printed `Decode error (<status> …)`,
  for a status such as 429: no schema declares that status. For a 500, see the empty 500 above. Declare the error on the binding when middleware answers with it, or on
  the action when its handler does.
- `HttpClientError` whose `reason._tag` is `InvalidUrlError` outside a browser: relative routes
  have no page to resolve against. Set `baseUrl`.
- Type error listing `HttpClient` as an unsatisfied requirement: provide one, such as
  `FetchHttpClient.layer`, or use `fetchClient`.
- `Expected 1 arguments` at a client method: `{}` is not a valid input for the action, so pass
  its input. Where the argument may be omitted, leave it out: `undefined` is a type error.
- Type error passing `{ payload: ... }` to a client method: `payload` is the native client's
  shape. Pass the input itself.
- `InvalidInput` `Expected Filters` given a plain object: the input is a class, which encodes
  only its instances. Pass `new Filters({ ... })`.
