# ActionDurableObject in a class of your own

A class with methods, sockets or handlers of its own extends the one `make` returns and
overrides them, its `services` a function of its `env`
([ActionDurableObject.md](ActionDurableObject.md)). This page is for a class that cannot: one
extending another base class, or holding its own runtime. It serves actions through the
primitives `make` is built from. A message the library throws says its fix; for workerd's, a
compiler diagnostic or Effect's own error, search
[ActionDurableObject-failures.md](ActionDurableObject-failures.md).

## Delegate to handlers

`handlers(this.ctx, options)` takes `make`'s options, with `services` a Layer, built from
`this.env` when they read it, and returns the object's handlers, each taking the runtime's own
arguments. Keep it in a private field, delegate the handlers the class serves this way, and
write the others. A class serving `calls` defines the method a stub calls, delegating:
`effectActionsRpc(request: ActionDurableObject.StubRequest) { return this.#object.effectActionsRpc(request); }`.
Its own methods run their Effects with `run(effect)`, which gives them the services, `State`,
`Feed` and a `Scope`, and stay callable over the stub beside it.

How the object builds, when it builds again, and which handlers resolve without a build are
on `ActionDurableObject.handlers`; the rules of each option on `ActionDurableObject.Options`;
what `run` builds per call on `ActionDurableObject.Handlers`' `run`.

## Compose the primitives yourself

A class with its own `ManagedRuntime` builds what `handlers` would, in one memo map shared by
the runtime and `HttpRouter.toWebHandler`:

- `State`, the object's `ctx`, for the services, provided with `Layer.succeed`.
- `Feed.layer`, the object's subscribers, requiring `State`, for the services, calls or routes
  that subscribe or publish: one, in the shared memo map, since `end` completes the live
  subscriptions of the `Feed` they subscribed through.
- `Sockets.layer`, the dispatcher `layerWebSocket` registers with: the class's socket handlers
  call `Sockets`' `message`, `close` and `error`, once the routes are built, and answer the
  sockets for which they succeed with `false`.
- `Calls.layer`, the dispatcher `layerStub()` registers with, merged out of the calls once: the
  class's `effectActionsRpc(request: ActionDurableObject.StubRequest)` runs `Calls`' `call`.

What each dispatcher requires of the memo map and of the build's order is on
`ActionDurableObject.Sockets` and `ActionDurableObject.Calls`.
