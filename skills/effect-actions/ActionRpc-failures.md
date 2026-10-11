# ActionRpc failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [ActionRpc.md](ActionRpc.md).

- `No action of these implementations is in this RPC binding: <names>` thrown by `layer`: none of the implementations' actions was passed to this binding's `make`. Implement the contract value the binding received; `(another contract)` marks an equal-looking copy.
- `Listed in actions, but the binding does not hold it: <names>`, or `but no implementation holds it`, thrown by `layer`: a listed action is not the binding's or the implementations', by identity.
- `Duplicate served action: <name>` thrown by `layer`: one call received two implementations of one bound action.
- `Duplicate middleware: <key>` thrown by `layer`: its `middleware` lists one twice.
- `Duplicate action: <name>` thrown by `make`: two actions share a name, or one is listed twice.
- `ActionRpc binding: error _tag "<tag>" is built in, and declared on every surface` thrown by `make`: a binding error is a built-in error, or reuses its tag. Drop the built-in one; rename your own.
- `Protected action '<name>' requires its matching authentication descriptor` thrown by `make` or `layer`: plain JavaScript gave no descriptor, or one of another identity.
- `No overload matches this call` at `make`, its last overload naming `"Protected actions take options naming their authentication"`, or `"Authentication descriptor does not cover every protected action"`: the binding holds a protected action and names no descriptor, or one of another identity. Give `{ authentication: Login }`.
- `ActionRpc serves a protocol speaking JSON: ...`, a defect when `layer` builds: the host provides another serialization, such as `layerSchemaBinary`. Provide a JSON one, on the client too.
- `Authentication "<name>": the binding's descriptor is not its provider's; build both from one descriptor`, a defect when `layer` builds: the binding and `Authentication.layer` were given two descriptors of one name.
- A type error on `middleware` naming `"Layer middleware fails only with the binding's errors and needs no client"`: a middleware declares an error neither the binding nor the built-ins hold, or is `requiredForClient`. Add the error to the binding's `error`, or move the check to the handler, declaring the error on its actions.
- `Provider<CurrentMember, "live-rpc.Login">` among the layer's requirements: the layer serves a protected action and its descriptor's provider is not provided. Provide it, `Layer.provide(authenticate)`.
- `Type 'HttpRouter' is not assignable to type 'never'` where the server is launched: the protocol was provided around `HttpRouter.serve`. Provide it to the rpc layer, inside.
- `HttpRouter` owed by a layer over stdio or a socket server: its descriptor's provider publishes a `protectedResource`, on the router. Give the provider serving that protocol none.
- `Request<"Requires", X>` owed over stdio or a socket server though no handler yields `X`: the verifier does, which only a router-mounted protocol's route provides. Read `X` in the verifier's build, or serve the protected actions over HTTP or a WebSocket.
- `Request<"Requires", X>` in the layer's type, or `X` not assignable to `never` where the server is launched: a handler or the authorizer yields `X`, which nothing per request provides. A startup layer of `X` does not count, nor a middleware in a list not written as a tuple, nor one listed before a middleware that requires `X`: the first listed is innermost. List a middleware providing it, or provide it with router middleware around the layer. Where `X` is the identity, a middleware requires it on a layer serving a public action: bind the protected actions alone, or read it with `Effect.serviceOption`.
- `Unauthenticated` `A bearer token is required.` from a browser over a WebSocket though the page has a token: it was meant for the upgrade, which a browser WebSocket cannot send. Send it on each message, `RpcClient.withHeaders`.
- A call dies with `Unknown request tag: <name>`: no layer serves that action, for which the client has a method all the same. Though a layer serves it: two `ActionRpc.layer`s were given one protocol, and only the first built receives its messages. Serve every rpc of a protocol from one layer; a second layer needs a protocol of its own, on another path.
- A call dies with `Internal server error`: a defect, an undeclared failure, a middleware that throws, or a success or a declared failure that does not encode. The cause is in the server's logs, and in its error reporters'; the connection's other calls go on.
- `RpcClientError` from every call: the client cannot reach the server, or its protocol, URL or path differ from the server's. Use the same serialization on both sides.
