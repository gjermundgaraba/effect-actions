# ActionRpc

Effect RPC on Effect's own `RpcServer` and `RpcClient`. `ActionRpc.make` binds actions to a
native `RpcGroup`, one rpc per action, and names the authentication descriptor of its
protected actions; the binding is shared by the server and every client. Servers serve it with
`ActionRpc.layer(Rpc, implementations)` over a protocol speaking JSON the host provides: each protected rpc authenticated per message, then the layer's `middleware`, then
input decoding, then its implementation's authorization. Clients call it with
`ActionRpc.client(Rpc)`, whose methods are `ActionHttp.client`'s.

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

Rpcs: each action is an rpc named after it, its payload the action's input, its success the
action's success. Every rpc declares its action's errors, the binding's `error`, and the
built-in `InvalidInput`, `Unauthenticated` and `Forbidden`; a protected one also declares its
descriptor's `error`, what the verifier may fail with.

Layer failures and startup requirements: the native server `Protocol`, which the host provides
with the serialization it needs, if any; the builders of the served implementations; the service of each listed
middleware; and, where it serves a protected action, the descriptor's provider,
`Authentication.layer`. The request services of each
implementation's authorizer and of the served handlers are router request requirements,
`HttpRouter.Request<"Requires", X>`, as over HTTP, until a listed middleware provides them;
the protected actions' identity excepted, which authentication supplies. All of them are
narrowed by `actions`: an action the layer leaves out owes nothing
([guarantees.md](guarantees.md#dependency-lifetimes)).

## Canonical

The binding, shared by the server and every client, names the authentication descriptor of its
protected actions, here the HTTP binding's ([Authentication.md](Authentication.md#canonical)):

```ts example=rpc-binding.ts
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Login } from "./binding.js";
import { GetUser, RenameUser, Status, WhoAmI } from "./contracts.js";

// Browser-safe, as the HTTP binding is: one native rpc per action, shared by the server and
// every client. Its protected rpcs authenticate with `Login`, the HTTP binding's descriptor,
// so one verifier serves both; `status` stays public.
export const Rpc = ActionRpc.make([Status, GetUser, RenameUser, WhoAmI], {
  authentication: Login,
});
```

### Serving

One layer serves the public and the protected actions over the protocol and serialization the
host provides: each protected rpc authenticates every message, and `status` stays open.

```ts example=rpc.ts
import { Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { authenticate } from "./authentication.js";
import { status, userActions } from "./handlers.js";
import { Rpc } from "./rpc-binding.js";

// Effect's own RpcServer, at /rpc of the host's router, over a WebSocket, speaking JSON. Each
// protected rpc authenticates every message with `Login`'s verifier, so one connection may
// carry several callers; `status` stays public.
export const layer = ActionRpc.layer(Rpc, [status, userActions]).pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(authenticate),
);
```

Serve it as HTTP is served, with `HttpRouter.serve` and a platform server, beside the HTTP and
MCP layers in one layer, so they share builders and the provider. `RpcServer.layerProtocolHttp({ path })`
serves the same rpcs over `POST`.

A request-time service, such as a tenant, comes from a listed middleware, or from router
middleware around the layer; a limit before decoding is a listed middleware too, failing only
with the binding's `error`:

```ts
export const Rpc = ActionRpc.make([Status, GetUser, RenameUser], {
  authentication: Login,
  error: RateLimited,
});

// ResolveTenant: RpcMiddleware.Service<ResolveTenant, { provides: Tenant }>()(...)
// Limit: RpcMiddleware.Service<Limit>()(..., { error: RateLimited })
const rpc = ActionRpc.layer(Rpc, [status, userActions], {
  middleware: [ResolveTenant, Limit],
}).pipe(
  Layer.provide([resolveTenant, limit]),
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(authenticate),
);
```

### Client

`client(Rpc)` is Effect's native `RpcClient` with one method per action, taking the action's
input directly and answering with its decoded success, as `ActionHttp.client` and
`Action.client` do.

```ts example=rpc-client.ts
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Rpc } from "./rpc-binding.js";

// A browser WebSocket sets no header on its upgrade, so the token travels on each message.
const asAlice = RpcClient.withHeaders({ authorization: "Bearer alice" });

// The methods of `ActionHttp.client`, over one connection.
export const lookup = Effect.gen(function* () {
  const client = yield* ActionRpc.client(Rpc);

  const status = yield* client.status();
  const user = yield* client.getUser({ id: "1" }).pipe(asAlice);
  const identity = yield* client.whoAmI().pipe(asAlice);

  return { status, user, identity };
});

// Effect's own client protocol: a WebSocket, speaking the server's JSON.
export const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket("ws://127.0.0.1:3000/rpc")),
  Layer.provide([RpcSerialization.layerJson, Socket.layerWebSocketConstructorGlobal]),
);
```

Run it with `lookup.pipe(Effect.scoped, Effect.provide(protocol))`; in Node, the protocol may
use `NodeSocket.layerWebSocket(url)` instead. The argument may be omitted when `{}` is a valid
encoded input, as on `ActionHttp.client`. Headers given with
`RpcClient.withHeaders` around a call go with that call's message; over the HTTP protocol,
`RpcClient.layerProtocolHttp({ url, transformClient })` also sends headers on every request.
The native client stays available: `RpcClient.make(Rpc.group)`, with methods taking the
payload, `{}` included.

## Rules

- The binding decides what RPC serves: the actions passed to `make`, and no others. Action names are unique within a binding. Selection follows HTTP's: `layer` serves the bound actions among the implementations, matched by identity, refuses implementations holding none of them, and `actions` narrows it, each listed action the binding's and held by an implementation ([ActionHttp.md](ActionHttp.md#rules), [guarantees.md](guarantees.md#names)). An action may be served once per `layer` call.
- The binding is plain data, browser-safe as `ActionHttp`'s is: `Rpc.group` is the group clients use, and carries none of the layer's middleware, which is server-only. In a browser, import it from a module with no server code ([setup.md](setup.md#browser)). A binding holding a protected action names its descriptor, and `make` refuses one of another identity, as `ActionHttp.make` does ([Authentication.md](Authentication.md#rules)).
- A listed middleware receives each message's payload as sent, not yet decoded, and as `rpc` the server's own rpc of the action, named after it, whose payload, success and error schemas are JSON.
- A call runs, in order: authentication, for a protected rpc only, then the layer's `middleware`, then input decoding, then the authorizer, then the handler ([guarantees.md](guarantees.md#authorization)). Each step refuses before the next runs, but input that does not decode still passes through the middleware, so a limit there counts it.
- Authentication is per message: one connection may carry several callers, each authenticated by its own message's credential. The credential is decoded from the rpc's headers with the descriptor's native scheme: over the HTTP protocol, the request's headers merged with the message's; over a WebSocket, the upgrade request's merged with each message's. A browser WebSocket sets no header on its upgrade, so a bearer token goes on each message, `RpcClient.withHeaders`. An API key in the query string never reaches it.
- A refusal is the call's typed `Unauthenticated` or `Forbidden`, with no HTTP status, no challenge, no step-up and no `Cache-Control`; a `Forbidden`'s `scopes` stay in its value. A missing bearer token is `Unauthenticated` `A bearer token is required.`; a verifier's own refusal arrives as it fails.
- Public and protected actions are served over any protocol: HTTP, a WebSocket, a socket server, stdio. A verifier reading a request service needs a router-mounted one, `RpcServer.layerProtocolHttp` or `layerProtocolWebsocket`, whose route provides it: authentication runs first, so no listed middleware can.
- The protocol speaks JSON: over `RpcSerialization.layerJson`, `layerNdjson`, `layerJsonRpc()` or `layerNdJsonRpc()`, whatever content type it names. `layer` refuses to build under any other codec, such as `layerSchemaBinary`'s, which writes a payload in its schema's own layout, read before anything runs: input is decoded only after authentication and the layer's middleware.
- `middleware` takes native `RpcMiddleware` services, which run around every rpc the layer serves, inside a protected rpc's authentication and outside its input decoding. The first listed is innermost, so an outer one provides what an inner one requires. The layer requires each one's service, and owes what each requires, less what one further out provides; a list not written as a tuple provides nothing. A middleware listed twice is refused.
- A middleware fails only with the binding's `error` or a built-in error, and needs no client counterpart: one declaring another error, or `requiredForClient`, is a type error, since clients decode only what every rpc declares and their group carries no middleware.
- A middleware may require the identity only where every action the layer serves is protected, as over HTTP: list the protected actions in `actions`, and serve the public ones from another layer.
- Request-time services are never startup services: a `Layer.succeed(Tenant, ...)` provided to the layer leaves `Tenant` owed. A listed middleware providing it satisfies it on every protocol, per message. Over a router-mounted protocol, so does router middleware or `HttpRouter.provideRequest` around the layer, which runs once per HTTP request, and over a WebSocket once for the upgrade, so once per connection, as does the context of `HttpRouter.serve` or `Testing.layer`. Over stdio or a socket server, only a listed middleware can ([guarantees.md](guarantees.md#dependency-lifetimes)).
- The binding's `error`, one schema or a list, is what middleware fails with: every rpc declares it, and every client decodes it. A handler failing with one lists it in its own action's `error`. It may not reuse a built-in error's tag.
- Input that does not decode is a typed `InvalidInput` listing `issues`, an undeclared field included, as over HTTP ([guarantees.md](guarantees.md#wire-behavior)). The authorizer and the handler never run.
- Anything an rpc does not declare, a defect of the verifier, of a middleware or of the handler, a failure plain JavaScript lets through or a middleware throws, or a declared failure or a success that does not encode, is logged with its cause and answered as that request's defect, an `Error` whose message is `Internal server error`, never its cause. The connection's other calls go on.
- A call failing with several errors at once is answered with the first, the one encoded; the others are dropped, as one HTTP response carries one error.
- Each such defect is reported once, with its real cause, and a declared failure, a refusal included, never is, as on every surface ([guarantees.md](guarantees.md#observability)). Effect's server reports every failed call, so the error a call is answered with and the generic defect are marked `ErrorReporter.ignore`: a reporter made with `ErrorReporter.make` skips them, and one written by hand skips them only by checking the mark.
- Actions are unary: no streaming rpc.
- Authorization, builders and spans follow [guarantees.md](guarantees.md).

### Client methods

- A method fails with a declared error as its decoded value: the action's own, the binding's, the built-in errors, and on a protected rpc the descriptor's. Match them with `Effect.catchTag`. Input that does not encode is `InvalidInput` with its `issues`, and nothing is sent.
- Anything else is Effect's own: `RpcClientError` when the server could not be reached, and a defect for an answer that does not decode or a server's `Internal server error`, an `Error`. Nothing is retried; a failed write may or may not have happened.
- `client` builds the native client once, on the `Protocol` in context, in the caller's scope. Every action of the binding has a method, whether or not a server serves it. Headers set with `RpcClient.withHeaders` around a call go with its message.
- The native client stays available: `RpcClient.make(Rpc.group)`, with methods taking the payload, `{}` included.
- In tests, serve the layer under `Testing.layer` with the HTTP protocol, and call it over `RpcClient.layerProtocolHttp` ([Testing.md](Testing.md#rpc)).

## Failure modes

- `No action of these implementations is in this RPC binding: <names>` thrown by `layer`: none of the implementations' actions was passed to this binding's `make`. Implement the exact contract value the binding received; `(another contract)` marks an equal-looking copy.
- `Listed in actions, but the binding does not hold it: <names>`, or `but no implementation holds it`, thrown by `layer`: those actions are not among the binding's or the implementations', by identity.
- `Duplicate served action: <name>` thrown by `layer`: one call received two implementations of the same bound action.
- `Duplicate middleware: <key>` thrown by `layer`: its `middleware` lists one middleware twice. List it once.
- `Duplicate action: <name>` thrown by `make`: two actions share a name, or one action value is listed twice.
- `ActionRpc binding: error _tag "<tag>" is built in, and declared on every surface` thrown by `make`: a binding error has a built-in tag, or is a built-in error. Drop a built-in error; rename an error of your own.
- `Protected action '<name>' requires its matching authentication descriptor` thrown by `make` or `layer`: plain JavaScript gave no descriptor, or one of another identity.
- `ActionRpc serves a protocol speaking JSON: RpcSerialization.layerJson, layerNdjson, layerJsonRpc or layerNdJsonRpc, not another codec, such as schema-binary's`, a defect when `layer` builds: the host provides another serialization, such as `layerSchemaBinary`. Provide a JSON one, on the client too.
- `Authentication "<name>": the binding's descriptor is not its provider's; build both from one descriptor`, a defect when `layer` builds: the binding and `Authentication.layer` were given two descriptors of one name.
- `No overload matches this call` at `make`, its last overload naming `"Protected actions take options naming their authentication"`, or `"Authentication descriptor does not cover every protected action"`: the binding holds a protected action and names no descriptor, or one of another identity. Give `{ authentication: Login }`.
- A type error on `middleware` naming `"Layer middleware fails only with the binding's errors and needs no client"`: a middleware declares an error neither the binding nor the built-ins hold, or is `requiredForClient`. Add the error to the binding's `error`, or move the check to the handler, declaring the error on its actions.
- `Provider<CurrentActor, "example.Login">` among the layer's requirements: the layer serves a protected action and its descriptor's provider is not provided. Provide it, `Layer.provide(authenticate)`.
- `HttpRouter` owed by a layer over stdio or a socket server: its descriptor's provider publishes a `protectedResource`, on the router. Give the provider serving that protocol none.
- `Request<"Requires", X>` owed over stdio or a socket server though no handler yields `X`: the verifier does, which only a router-mounted protocol's route provides. Read `X` in the verifier's build, or serve the protected actions over HTTP or a WebSocket.
- `Request<"Requires", X>` in the layer's type, or `X` not assignable to `never` where the server is launched: a handler or the authorizer yields `X`, which nothing per request provides. A startup layer of `X` does not count. List a middleware providing it, or provide it with router middleware around the layer; `X` the identity on a layer serving public actions: serve the middleware's protected actions from a layer of their own.
- `Unauthenticated` `A bearer token is required.` from a browser over a WebSocket though the page has a token: it was meant for the upgrade, which a browser WebSocket cannot send. Send it on each message, `RpcClient.withHeaders`.
- A call dies with `Internal server error`: a defect, an undeclared failure, a middleware that throws, or a success or a declared failure that does not encode. The cause is in the server's logs, and in its error reporters'.
- `RpcClientError` from every call: the client cannot reach the server, or its protocol, URL or path differ from the server's. Use the same serialization on both sides.
