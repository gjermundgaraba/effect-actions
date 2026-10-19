# ActionDurableObject failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [ActionDurableObject.md](ActionDurableObject.md); a surface's own failures are
in the core's `*-failures.md` pages.

- `is not assignable to type 'Layer<never, never, Allowed>'` at `make`'s `routes`: the routes
  require a service no layer provides. The union before it lists every requirement; those
  other than `State`, `HttpRouter` and the platform's (`FileSystem`, `Path`, `HttpPlatform`,
  `Generator`) are missing: provide their Layers to the routes. Where it names
  `Request<"Requires", X>`, a handler or an authorizer reads `X` per request: see the core's
  `ActionRpc-failures.md` and `ActionHttp-failures.md`.
- A call over the socket dies with `Internal server error` though router middleware or
  `HttpRouter.provideRequest` provides a service its handler reads: those run for the upgrade
  request alone, never a socket's messages. List an `RpcMiddleware` in `ActionRpc.layer`'s
  `middleware`, or make it a startup service.
- `No ActionDurableObject.layerWebSocket of these routes accepted this socket`, thrown by
  `webSocketMessage`: the object holds a socket no protocol of these routes accepted, such as one
  accepted by code of your own, or by an earlier version of the routes at another `path`. Accept
  sockets with `layerWebSocket` alone, and close those the old path accepted.
- `Two ActionDurableObject.layerWebSocket protocols of one object serve the path <path>: a router
  prefix does not tell them apart`, a defect when the routes build: two `ActionRpc.layer`s in one
  object were given protocols at one `path`. Give each its own, such as `/a/rpc` and `/b/rpc`.
- `ActionDurableObject.layerWebSocket serves only the routes of a class ActionDurableObject.make
  returns`, a defect when the routes build: they are served by `HttpRouter.toWebHandler` or a
  class of your own, and nothing would receive the sockets' events. Serve them with `make`.
- `ActionDurableObject.make was given no alarm`, a rejected alarm the runtime retries: something
  set an alarm on an object made without `alarm`. Give `make` an `alarm`, or stop setting one.
- A stub's `fetch` rejects with the routes' build failure, every request alike: the routes fail
  to build. The object is reset, and the next request builds them again; fix the failure the
  rejection names.
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
