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
- `ActionDurableObject.make was given no alarm`, a rejected alarm the runtime retries: something
  set an alarm on an object made without `alarm`. Give `make` an `alarm`, or stop setting one.
- A stub's `fetch` rejects with the routes' build failure, every request alike: the routes fail
  to build. The object is reset, and the next request builds them again; fix the failure the
  rejection names.
- An upgrade answered `426 Expected a WebSocket upgrade`: the request to the socket's `path` is
  not an upgrade. Connect with a WebSocket client, or forward the page's `Request` itself from
  the Worker, which forwards its `Upgrade` header.
- An upgrade answered `431`, `The credential and the headers a socket keeps exceed its
  attachment`: the credential and the listed `headers` exceed the runtime's 16 KiB attachment.
  Send a smaller token, list fewer headers, or send them on each message.
- `Unauthenticated` `A bearer token is required.` from a page's socket though the page has a
  token: a browser WebSocket sets no header on its upgrade. Send the token on each message, with
  `RpcClient.withHeaders`.
- An upgrade fails with `RpcServer.layerProtocolWebsocket` in the routes: a web handler's
  request cannot be upgraded by Effect's server. Use `layerWebSocket`.
