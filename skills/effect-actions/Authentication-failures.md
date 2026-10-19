# Authentication failure modes

What you see when something is wrong, and the fix: compiler diagnostics and errors the library
does not word. Search for a fragment of the message. A message the library throws says its
fix itself. Tasks: [Authentication.md](Authentication.md),
[Authentication-advanced.md](Authentication-advanced.md).

## Types and startup

- `Provider<CurrentUser, "notes-service.Login">` among a layer's requirements, `Type 'Provider<...>' is not assignable to type 'never'` at `Layer.launch` or `NodeRuntime.runMain`, or `Expected 2 arguments, but got 1` at a web handler's `handler(request)`: a layer serving protected actions requires the provider of the descriptor it names, and nothing else satisfies it, neither the identity nor another descriptor's provider. Provide it, `Layer.provide(authenticate)` ([Verify credentials](Authentication.md#verify-credentials)).
- `Property 'authentication' is missing`, or `No overload matches this call` with `"Protected actions take options naming their authentication"` or `"Authentication descriptor does not cover every protected action"`, at `ActionHttp.make`, `ActionRpc.make` or `ActionMcp.layerHttp`: a protected action is served and no descriptor is named. Give `{ authentication: Login }` ([Declare how callers sign in](Authentication.md#declare-how-callers-sign-in)).
- `Type 'Other' is not assignable to type 'CurrentUser'` under `Descriptor<…>`, at `authentication`: the descriptor authenticates another identity than the action's `caller`. Name the descriptor made for the caller's identity service.
- `is not assignable to type 'Forbidden | Unauthenticated'`, or `Property '…' is missing in type`, at `layer`'s verifier: it fails with an error that is neither a refusal nor one its descriptor declares, or succeeds with a value that is not the identity. Declare the error in the descriptor's `error`, or map it to a refusal where it is the caller's.
- `Request<"Requires", Tenant>` still owed although the tenant middleware's layer is provided: it is in one `Layer.provide([...])` array with the provider, whose members do not provide to one another. Provide it in a later `Layer.provide` of its own ([Read request context in a verifier](Authentication-advanced.md#read-request-context-in-a-verifier)).

## Scopes

- `Schema validation failed` thrown by `new Action.Forbidden({ scopes })`: a scope is no OAuth scope token, being empty or holding a space, `"`, `\` or a character outside printable ASCII. Give each scope as its own element.
- An MCP client reports `InsufficientScopeError` instead of re-authorizing: it has no OAuth provider configured. Configure one, or grant the scope up front.
