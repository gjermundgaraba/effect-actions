# ActionDurableObject in a class of your own

A class with methods, sockets or handlers of its own extends the one `make` returns and overrides them, its `services` a function of its `env` ([ActionDurableObject.md](ActionDurableObject.md)). This page is for a class that cannot, such as one extending another base class: it delegates to the handlers `make` is built from. A message the library throws says its fix; for workerd's, a compiler diagnostic or Effect's own error, search [ActionDurableObject-failures.md](ActionDurableObject-failures.md).

## Delegate to handlers

`handlers(this.ctx, options)` takes `make`'s options, with `services` a Layer, built from `this.env` when they read it, and returns the object's handlers, each taking the runtime's own arguments. Keep it in a private field, delegate the handlers the class serves this way, and write the others. A class serving `calls` defines the method a stub calls, delegating: `effectActionsRpc(request: ActionDurableObject.StubRequest) { return this.#object.effectActionsRpc(request); }`. Its own methods run their Effects with `run(effect)`, which gives them the services, `State`, `Alarm`, `Event.Events` and a `Scope`, and stay callable over the stub beside it. Delegate `alarm` too, given an `alarm` option or not: `Alarm`'s times and `layerWebhooks`' waits run through it.

How the object builds, when it builds again, and which handlers resolve without a build are on `ActionDurableObject.handlers`; the rules of each option on `ActionDurableObject.Options`; what `run` builds per call on `ActionDurableObject.Handlers`' `run`.
