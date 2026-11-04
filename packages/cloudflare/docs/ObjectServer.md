# ObjectServer

An object's routes and sockets, served by a Durable Object class that `ActionDurableObject.make` does not build and that cannot delegate to `ActionDurableObject.handlers` either, such as one whose base class builds its per-object services as a Layer, once per object, and runs each of its events as an Effect. The routes are the ones `make` serves, as the core's surfaces build them, such as `ActionRpc.layer` over `ActionDurableObject.layerWebSocket`. [ActionDurableObject.md](ActionDurableObject.md) defines objects, instances and the routes; a class with a base class of its own that builds no Layer is on [ActionDurableObject-own-class.md](ActionDurableObject-own-class.md).

Import `@gjermundgaraba/effect-actions-cloudflare/ObjectServer`. A message the library throws says its fix; for workerd's, a compiler diagnostic or Effect's own error, search [ObjectServer-failures.md](ObjectServer-failures.md), then [ActionDurableObject-failures.md](ActionDurableObject-failures.md).

## Serve routes from a Layer of the object

Put `ObjectServer.layer(routes)` in the Layer the base class builds for the object, with `ActionDurableObject.State` provided from the object's `ctx`. Delegate the class's `fetch`, `webSocketMessage`, `webSocketClose` and `webSocketError` to the `ObjectServer` service's Effects, run as the base class runs its events. A service in the same Layer that publishes events requires the `Event.Events` the Layer outputs, the one the routes' sockets watch. The routes may require what `make`'s may, except `Alarm`, `Tasks` and `Waits`, which need the object's alarm, and any service the Layer is given.

What it builds and how to build it are on `ObjectServer.layer`; which scheduler each Effect runs on is on `ObjectServer.ObjectServer`.
