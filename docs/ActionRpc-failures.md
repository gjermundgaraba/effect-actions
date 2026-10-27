# ActionRpc failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message. The tasks are in [ActionRpc.md](ActionRpc.md).

- A type error on `middleware` naming `"Layer middleware fails only with the binding's errors and needs no client"`: a middleware declares an error neither the binding nor the built-ins hold, or is `requiredForClient`. Add the error to the binding's `error`, or check in the handler, declaring the error on its actions.
- `Type 'HttpRouter' is not assignable to type 'never'` where the server is launched: an rpc protocol was provided around `HttpRouter.serve`, whose router it adds its route to. Provide the protocol to the rpc layer.
- `HttpRouter` owed by an `ActionRpc.layer` over stdio or a socket server: its authentication provider publishes a `protectedResource`, on a router those protocols lack. Give the provider serving that protocol no `protectedResource`.
- `Request<"Requires", X>` owed by an `ActionRpc.layer` over stdio or a socket server though no handler yields `X`: the verifier yields `X`, which only a router-mounted protocol's route provides. Read `X` in the verifier's build, or serve the protected actions over HTTP or a WebSocket.
- `Request<"Requires", X>` in the type of `ActionRpc.layer`, or `X` not assignable to `never` where the server is launched: a handler, the authorizer or a middleware yields `X`, which nothing provides per request, and a startup layer of `X` does not count. List a middleware providing `X`, by the rules on `ActionRpc.LayerOptions.middleware`, or provide `X` with router middleware around the layer.
- A call dies with `Unknown request tag: <name>`: no layer serves the action, for which the client has a method all the same, or a second `ActionRpc.layer` was given the same protocol. Serve every rpc of a protocol from one layer, or give the second a protocol on another path.
- `RpcClientError` from every call, Effect's own error: the client could not reach the server. Check the client's protocol, URL and path against the server's.
