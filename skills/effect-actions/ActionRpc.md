# ActionRpc

Actions as Effect RPC, on Effect's own `RpcServer` and `RpcClient`: one unary rpc per action.
Reach for it when a client keeps a connection open and calls often, such as a page on a
WebSocket, or when the application already speaks Effect RPC.

Read this page alone, in one tool call: pages read together are cut. When something fails,
search [ActionRpc-failures.md](ActionRpc-failures.md). Reading order: [SKILL.md](SKILL.md).

## API

Import `@gjermundgaraba/effect-actions/ActionRpc`.

| API                                     | Purpose                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `make(actions, options?)`               | Bind a list of actions; returns a `Binding`.                               |
| `Rpc.actions`                           | The bound actions.                                                         |
| `Rpc.error`                             | The errors every rpc declares besides its action's own.                    |
| `Rpc.authentication`                    | The authentication descriptor of its protected actions, or `undefined`.    |
| `Rpc.group`                             | Native `RpcGroup`, one rpc per action, for `RpcClient.make`.               |
| `layer(Rpc, implementations, options?)` | Serve the rpcs of the bound actions the implementations hold.              |
| `client(Rpc, options?)`                 | An Effect of a typed client; requires the client `Protocol` and a `Scope`. |

Exported types: `Binding`; `Any`, any binding; `Client<typeof Rpc>`; `MethodError`, what one call fails with; `Options` of `make`, `LayerOptions` of `layer`, `ClientOptions` of `client`.

| Option                   | Meaning                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `make`: `error`          | Errors the layer's `middleware` fails with: declared by every rpc, so clients decode them.             |
| `make`: `authentication` | `Authentication.make(...)` of the protected actions' identity: required when the binding holds one.    |
| `layer`: `actions`       | The bound actions it serves: `[GetUser]`. Defaults to every one the implementations hold.              |
| `layer`: `middleware`    | Native `RpcMiddleware` around every rpc, inside authentication, outside decoding; the first innermost. |
| `client`: options        | The native `RpcClient.make` options but `flatten`.                                                     |

## Bind actions to rpcs

Call `ActionRpc.make` once, in a file that imports no server code
([setup.md](setup.md#bundle-for-a-browser)), and export the binding: the server serves it and
every client calls it. A binding that holds a protected action names its authentication
descriptor ([Authentication.md](Authentication.md#declare-how-callers-sign-in)).

```ts
export const Rpc = ActionRpc.make([ListRooms, ...Messages], { authentication: Login });
```

[live-rpc/src/Rpc.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/Rpc.ts) is that binding;
[kitchen-sink/src/Rpc.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Rpc.ts) adds `error`.

Nothing streams. A page that follows changes calls again on its open socket, as `readMessages`
does in [live-rpc/src/chat/Chat.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/chat/Chat.ts).

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

[live-rpc/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/routes.ts) and
[live-rpc/src/server.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/server.ts) are the two halves.

- Provide the protocol to the rpc layer, inside what `HttpRouter.serve` serves:
  `RpcServer.layerProtocolWebsocket` and `layerProtocolHttp` add their route to that router.
- Export the rpc layer before it is given a protocol. `Testing.layer` cannot upgrade a
  WebSocket, so a test gives that layer the HTTP protocol ([Testing.md](Testing.md#test-rpcs)).
- Provide a JSON serialization, the same one on the client: `RpcSerialization.layerJson`,
  `layerNdjson`, `layerJsonRpc()` or `layerNdJsonRpc()`.
- Bound a WebSocket message on the server: `HttpServerRequest.MaxBodySize` does not, and Node's
  reads up to 100 MiB whole. `server.ts` passes `websocket: { maxPayload }` to
  `NodeHttpServer.layer`; a larger message closes the socket.
- Authentication runs for every message of a protected rpc, not once per connection.
- A limit in `middleware` may key on the caller and counts input that does not decode, as the
  quota of [kitchen-sink/src/identity/quota.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/identity/quota.ts)
  does; a limit in a handler holds on every surface.
- A middleware may require the identity only where every action its layer serves is
  protected, and one protocol takes one `ActionRpc.layer`: a second layer given the same
  protocol is never reached. So bind the protected actions alone, as
  [kitchen-sink/src/Rpc.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/Rpc.ts) does, or have the middleware
  read the identity with `Effect.serviceOption`, which a public rpc's call lacks.
- A protocol with no router, such as `RpcServer.layerProtocolSocketServer` or
  `layerProtocolStdio`, serves protected actions too, but has no HTTP request, which limits its
  provider and its verifier: [ActionRpc-failures.md](ActionRpc-failures.md).
- **The same actions as JSON too.** Merge `ActionHttp.layer(Http, implementations)` beside the
  rpc layer, each given its descriptor's provider
  ([kitchen-sink/src/routes.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/routes.ts)): one provider given to
  both is built once. The routes need what
  the rpcs did not: an `httpApiStatus` on each declared error, which answers 422 without one
  ([live-rpc/src/chat/Chat.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/chat/Chat.ts)); a request body limit;
  and router middleware for a service an `RpcMiddleware` provides
  ([ActionHttp.md](ActionHttp.md#serve-the-routes)). Write the header's decoding once, in a
  function both middleware call.

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
[live-rpc/src/browser.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/browser.ts) is a page's client module, and
[live-rpc/src/client.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/client.ts) runs it from Node.

- The socket belongs to the Layer providing the protocol, not to the scope around the client:
  provide the connection once, around the page's whole program, never around one call. A page
  that is not one Effect program keeps it in a `ManagedRuntime` and calls with promises:
  `connect(url)` in `browser.ts`, whose socket opens on the first call.
- A declared error or a refusal is its call's typed failure: only that call fails, and the
  socket stays open. RPC answers no 401 or 403 challenge, and a token may expire under an open
  socket, so the page handles `Unauthenticated` itself
  ([guarantees.md](guarantees.md#wire-behavior)).

## Send request context with a call

What travels beside a call's input, such as a token, a tenant or a room, goes in headers. On
the client, wrap the call in `RpcClient.withHeaders`:

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

[live-rpc/src/chat/room.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/chat/room.ts) is that middleware, and
[live-rpc/src/browser.ts](node_modules/@gjermundgaraba/effect-actions/examples/live-rpc/src/browser.ts) the client sending the header.

- Over a WebSocket, a message's headers are the upgrade request's with its own merged over
  them. A browser WebSocket sets no header on its upgrade, so a bearer token goes on each
  message, and a refreshed token needs no new socket.
- A cookie the browser attaches to the upgrade covers every message
  ([kitchen-sink/src/browser.ts](node_modules/@gjermundgaraba/effect-actions/examples/kitchen-sink/src/browser.ts)). A browser attaches
  it from any page, so refuse a foreign `Origin` on the upgrade, with a request policy
  ([Authentication-advanced.md](Authentication-advanced.md#run-a-request-policy-before-authentication)).
- An API key in the query string never reaches authentication.
- A request-time requirement is never a startup service: `Layer.succeed(CurrentRoom, "lobby")`
  provided to the layer leaves `CurrentRoom` owed, in its type.
- Router middleware or `HttpRouter.provideRequest` around the layer provides one too, but over
  a WebSocket it runs once, for the upgrade, so its value holds for the whole connection. What
  differs per message needs a listed middleware.
- Authentication runs outside the listed middleware, so none of them provides what a verifier
  reads
  ([Authentication-advanced.md](Authentication-advanced.md#read-request-context-in-a-verifier)).
