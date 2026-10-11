# ActionRpc

Actions as Effect RPC, on Effect's own `RpcServer` and `RpcClient`: one unary rpc per action.
Reach for it when a client keeps a connection open and calls often, such as a page on a
WebSocket, or when the application already speaks Effect RPC.

## API

Import `@gjermundgaraba/effect-actions/ActionRpc`.

| API                                     | Purpose                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `make(actions, options?)`               | Bind a list of actions; returns a `Binding`. Options are required for a protected action. |
| `Rpc.actions`                           | The exact bound actions.                                                                  |
| `Rpc.error`                             | The errors every rpc declares besides its action's own.                                   |
| `Rpc.authentication`                    | The authentication descriptor of its protected actions, or `undefined`.                   |
| `Rpc.group`                             | Native Effect `RpcGroup`, one rpc per action, for `RpcClient.make`; `layer` serves it.    |
| `layer(Rpc, implementations, options?)` | Serve the rpcs of the bound actions these implementations hold, or the listed ones.       |
| `client(Rpc, options?)`                 | An Effect of a typed client; requires the native client `Protocol` and a `Scope`.         |

Exported types: `Binding`; `Any`, any binding; `Client`, a client's type: `Client<typeof Rpc>`; `MethodError`, what one of its calls fails with; `Options` of `make`, `LayerOptions` of `layer` and `ClientOptions` of `client`.

| Option                   | Meaning                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `make`: `error`          | Errors the layer's `middleware` fails with, such as a limit before decoding: declared by every rpc, so clients decode them. |
| `make`: `authentication` | The descriptor of the protected actions' identity, `Authentication.make(...)`: required when the binding holds one.         |
| `layer`: `actions`       | The bound actions it serves, among the implementations': `[GetUser]`. Defaults to every one they hold.                      |
| `layer`: `middleware`    | Native `RpcMiddleware` run around every rpc the layer serves, inside authentication, outside decoding; the first innermost. |
| `client`: options        | The native `RpcClient.make` options but `flatten`: `spanPrefix`, `spanAttributes`, `generateRequestId`, `disableTracing`.   |

## Bind actions to rpcs

Call `ActionRpc.make` once, in a file that imports no server code
([setup.md](setup.md#bundle-for-a-browser)), and export the binding: the server serves it and
every client calls it. A binding that holds a protected action names its authentication
descriptor ([Authentication.md](Authentication.md#declare-how-callers-sign-in)).

```ts
export const Rpc = ActionRpc.make([ListRooms, ...Messages], { authentication: Login });
```

[live-rpc/src/Rpc.ts](../examples/live-rpc/src/Rpc.ts) is that binding;
[kitchen-sink/src/Rpc.ts](../examples/kitchen-sink/src/Rpc.ts) adds `error`.

Actions are unary: nothing streams. A page that follows changes calls again on its open
socket, as `readMessages` does in
[live-rpc/src/chat/Chat.ts](../examples/live-rpc/src/chat/Chat.ts).

## Serve the rpcs

In the routes file, give `ActionRpc.layer` the binding and the implementations, and provide
what it requires except the protocol: the service of each listed middleware and, where it
serves a protected action, the authentication provider
([Authentication.md](Authentication.md#verify-credentials)). The entrypoint chooses the
protocol and its serialization, then serves the result with `HttpRouter.serve`.

```ts
// routes.ts
export const rpc = ActionRpc.layer(Rpc, [rooms, messages], { middleware: [ResolveRoom] }).pipe(
  Layer.provide([resolveRoom, authenticate]),
);

// server.ts
const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);
```

[live-rpc/src/routes.ts](../examples/live-rpc/src/routes.ts) and
[live-rpc/src/server.ts](../examples/live-rpc/src/server.ts) are the two halves.

- Provide the protocol to the rpc layer, inside what `HttpRouter.serve` serves:
  `RpcServer.layerProtocolWebsocket` and `layerProtocolHttp` add their route to that router.
- Export the rpc layer before it is given a protocol, as `rpc` is in both examples.
  `Testing.layer` cannot upgrade a WebSocket, so a test gives that layer
  `RpcServer.layerProtocolHttp`, and its client `RpcClient.layerProtocolHttp`
  ([Testing.md](Testing.md#test-rpcs)).
- Provide a JSON serialization, the same one on the client: `RpcSerialization.layerJson`,
  `layerNdjson`, `layerJsonRpc()` or `layerNdJsonRpc()`.
- Authentication runs for every message of a protected rpc, not once per connection: a socket
  has no identity of its own.
- A limit in `middleware` may key on the caller and counts input that does not decode, as the
  quota of [kitchen-sink/src/identity/quota.ts](../examples/kitchen-sink/src/identity/quota.ts)
  does; a limit in a handler holds on every surface.
- A middleware may require the identity only where every action its layer serves is
  protected, and one protocol takes one `ActionRpc.layer`: a second layer given the same
  protocol is never reached. So bind the protected actions alone, as
  [kitchen-sink/src/Rpc.ts](../examples/kitchen-sink/src/Rpc.ts) does, or have the middleware
  read the identity with `Effect.serviceOption`, which a public rpc's call lacks.
- A protocol with no router, such as `RpcServer.layerProtocolSocketServer` or
  `layerProtocolStdio`, serves public and protected actions too. It has no HTTP request, which
  limits its provider and its verifier: see [Failure modes](#failure-modes).

## Call the rpcs

`ActionRpc.client(Rpc)` has the methods of `ActionHttp.client`
([ActionHttp.md](ActionHttp.md#call-the-api-from-effect)): `client.readMessages({ after })`.
Its connection is a Layer of Effect's own:

```ts
export const connection = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(RpcSerialization.layerJson),
  );
```

It leaves the WebSocket constructor to its host: a page provides
`Socket.layerWebSocketConstructorGlobal`, and Node `NodeSocket.layerWebSocketConstructor`.
[live-rpc/src/browser.ts](../examples/live-rpc/src/browser.ts) is a page's client module, and
[live-rpc/src/client.ts](../examples/live-rpc/src/client.ts) runs it from Node.

- The socket belongs to the Layer providing the protocol, not to the scope around the client.
  It opens when that Layer is built and closes when it is released, so provide the connection
  once, around the page's whole program, never around one call. A page that is not one Effect
  program keeps it in a `ManagedRuntime`. `Effect.scoped` holds the client alone.
- A declared error or a refusal is its call's typed failure, matched with `Effect.catchTag`:
  only that call fails, and the socket stays open. RPC answers no 401 or 403 challenge, and a
  token may expire under a socket that stays up, so the page handles `Unauthenticated` itself
  ([guarantees.md](guarantees.md#wire-behavior)).

## Send request context with a call

What travels beside a call's input, such as a token, a tenant or a room, goes in headers. On
the client, wrap the call in `RpcClient.withHeaders`: the headers go with that call's message.

```ts
const here = RpcClient.withHeaders({ authorization: `Bearer ${token}`, [roomHeader]: name });

client.postMessage({ text }).pipe(here);
```

On the server, authentication decodes the credential from those headers. Anything else is read
by native `RpcMiddleware` listed in `layer`'s `middleware`, which provides it as a service to
the handlers and to `authorize`:

```ts
export class ResolveRoom extends RpcMiddleware.Service<ResolveRoom, { provides: CurrentRoom }>()(
  "live-rpc/ResolveRoom",
) {}

export const resolveRoom = Layer.succeed(ResolveRoom, (call, { headers }) =>
  Effect.provideService(call, CurrentRoom, headers[roomHeader] ?? defaultRoom),
);
```

[live-rpc/src/chat/room.ts](../examples/live-rpc/src/chat/room.ts) is that middleware, and
[live-rpc/src/browser.ts](../examples/live-rpc/src/browser.ts) the client sending the header.

- Over a WebSocket, a message's headers are the upgrade request's with its own merged over
  them. A browser WebSocket sets no header on its upgrade, so a bearer token goes on each
  message, and a refreshed token needs no new socket. A cookie the browser attaches to the
  upgrade covers every message
  ([kitchen-sink/src/browser.ts](../examples/kitchen-sink/src/browser.ts)), and a browser
  attaches it from any page, so refuse a foreign `Origin` on the upgrade, with a request policy
  ([Authentication.md](Authentication.md#run-a-request-policy-before-authentication)). An API
  key in the query string never reaches authentication.
- A request-time requirement is never a startup service: `Layer.succeed(CurrentRoom, "lobby")`
  provided to the layer leaves `CurrentRoom` owed, in its type.
- Router middleware or `HttpRouter.provideRequest` around the layer provides one too, but over
  a WebSocket it runs once, for the upgrade, so its value holds for the whole connection. What
  differs per message needs a listed middleware.
- Authentication runs outside the listed middleware, so none of them provides what a verifier
  reads ([Authentication.md](Authentication.md#read-request-context-in-a-verifier)).

## Examples

| File                                                                                                 | Shows                                                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [live-rpc/src/Rpc.ts](../examples/live-rpc/src/Rpc.ts)                                               | A binding naming its authentication descriptor.                                |
| [live-rpc/src/routes.ts](../examples/live-rpc/src/routes.ts)                                         | The rpcs with their provider and middleware, before a protocol is chosen.      |
| [live-rpc/src/server.ts](../examples/live-rpc/src/server.ts)                                         | The WebSocket protocol, speaking JSON, under `HttpRouter.serve`.               |
| [live-rpc/src/chat/room.ts](../examples/live-rpc/src/chat/room.ts)                                   | `RpcMiddleware` providing a per-message service from a header.                 |
| [live-rpc/src/browser.ts](../examples/live-rpc/src/browser.ts)                                       | The connection Layer, the client, a token per message, errors handled by tag.  |
| [live-rpc/src/client.ts](../examples/live-rpc/src/client.ts)                                         | That client run from Node: two callers on one socket.                          |
| [live-rpc/test/routes.test.ts](../examples/live-rpc/test/routes.test.ts)                             | The rpcs in memory over the HTTP protocol; the native client of `Rpc.group`.   |
| [live-rpc/test/browser.test.ts](../examples/live-rpc/test/browser.test.ts)                           | The page's client against the same rpcs.                                       |
| [kitchen-sink/src/Rpc.ts](../examples/kitchen-sink/src/Rpc.ts)                                       | `make` with `error`, and a cookie descriptor.                                  |
| [kitchen-sink/src/identity/quota.ts](../examples/kitchen-sink/src/identity/quota.ts)                 | One quota as HTTP and as RPC middleware, keyed by the caller.                  |
| [kitchen-sink/src/routes.ts](../examples/kitchen-sink/src/routes.ts)                                 | The socket merged beside HTTP routes and an MCP endpoint, in one served layer. |
| [kitchen-sink/src/browser.ts](../examples/kitchen-sink/src/browser.ts)                               | A client relying on the session cookie of the upgrade.                         |
| [kitchen-sink/test/identity/session.test.ts](../examples/kitchen-sink/test/identity/session.test.ts) | A cookie per message in a test; one quota spent over HTTP and RPC.             |

## Failure modes

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
