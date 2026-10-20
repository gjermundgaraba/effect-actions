# ActionDurableObject failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [ActionDurableObject.md](ActionDurableObject.md); a surface's own failures are
in the core's `*-failures.md` pages.

- `is not assignable to type 'Allowed<never, never>'` at `make`'s or `handlers`' `routes`, or `Allowed<X, Y>`
  where the routes provide `X` themselves and `services` provides `Y`: the routes require a
  service no layer provides. The union before it lists every requirement; those other than
  `State`, `Sockets`, `HttpRouter`, the platform's (`FileSystem`, `Path`, `HttpPlatform`, `Generator`) and
  `Y` are missing: add their Layers to `services`, or provide them to the routes. Where it names
  `Request<"Requires", Z>`, a handler or an authorizer reads `Z` per request: see the core's
  `ActionRpc-failures.md` and `ActionHttp-failures.md`.
- A call over the socket dies with `Internal server error` though router middleware or
  `HttpRouter.provideRequest` provides a service its handler reads: those run for the upgrade
  request alone, never a socket's messages. List an `RpcMiddleware` in `ActionRpc.layer`'s
  `middleware`, or make it a startup service.
- A socket's messages go unanswered, with no error: no protocol of these routes accepted it,
  so `Sockets` answers `false` and `handlers` resolves its events. Accepted by your own code,
  answer the sockets carrying your tag in `webSocketMessage`; accepted by an earlier version of
  the routes at another `path`, close it, or serve that `path` again.
- In a class composing the primitives itself, every socket's messages go unanswered, with no
  error, though its upgrade succeeded: the runtime dispatching through `Sockets` and
  `toWebHandler` were given two memo maps, so each built `Sockets.layer`, and `layerWebSocket`
  registered with one while the class dispatches through the other. Give `ManagedRuntime.make`
  and `toWebHandler` one `memoMap`
  ([ActionDurableObject-own-class.md](ActionDurableObject-own-class.md#compose-the-primitives-yourself)).
- In such a class, a socket's first message after the object was idle goes unanswered, or
  reaches the class's own answer, while later ones are served: it was dispatched before the
  routes were built, and no protocol had registered with `Sockets` yet. Await the routes' build
  before dispatching, or delegate to `handlers`, which does.
- `Effect<Context<Protocol>, never, Sockets>` is not assignable, or `Sockets` is missing among a
  Layer's requirements: `layerWebSocket` registers with the instance's `Sockets`. Provide
  `Sockets.layer`, in the memo map the class dispatches through.
- `Two ActionDurableObject.layerWebSocket protocols of one object serve the path <path>: a router
  prefix does not tell them apart`, a defect when the routes build: two `ActionRpc.layer`s in one
  object were given protocols at one `path`. Give each its own, such as `/a/rpc` and `/b/rpc`.
- `ActionDurableObject.layerWebSocket registers only with a Sockets that Sockets.layer built`, a
  defect when the routes build: a `Sockets` of your own was provided, such as one
  `Layer.succeed` makes for a test. Provide `Sockets.layer`.
- `Your Durable Object class must have an alarm() handler in order to call setAlarm()`, thrown by
  `storage.setAlarm` on workerd: the object was made without an `alarm`. Give `make` an
  `alarm`, or define the class's own, or stop setting one. celld 0.6.2 accepts the call instead and drops the alarm when it
  is due, so an alarm that never runs there may mean the same.
- `Unauthenticated` on a socket that sent its token on the upgrade, after the object was idle:
  the runtime dropped the socket's attachment, where its upgrade headers are kept, as celld
  0.6.2 does when it evicts an idle object. Send the token on each message, with
  `RpcClient.withHeaders`.
- A stub's `fetch`, or a method calling `run`, rejects with a build failure: the services or the
  routes fail to build, and either shows the same. Events awaiting that build reject with it,
  and the next event builds everything again; fix the failure the rejection names.
- An upgrade answered `426 Expected a WebSocket upgrade`: the request to the socket's `path` is
  not an upgrade. Connect with a WebSocket client, or forward the page's `Request` itself from
  the Worker, which forwards its `Upgrade` header.
- An upgrade answered `431`, `The headers a socket keeps exceed its attachment`: the upgrade
  request's headers, its cookies included, exceed the runtime's 16 KiB attachment. Send fewer or
  smaller cookies to the socket's path, or send a large token on each message.
- `Unauthenticated` `A bearer token is required.` from a page's socket though the page has a
  token: a browser WebSocket sets no header on its upgrade. Send the token on each message, with
  `RpcClient.withHeaders`.
- An upgrade fails with `RpcServer.layerProtocolWebsocket` in the routes: a web handler's
  request cannot be upgraded by Effect's server. Use `layerWebSocket`.
