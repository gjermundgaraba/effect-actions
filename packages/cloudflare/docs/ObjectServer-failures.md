# ObjectServer failure modes

Messages the library does not own, the compiler's and Effect's, and the fix. Search for a fragment of the message; one the library throws says its own fix. The task is in [ObjectServer.md](ObjectServer.md); the object's own failures are in [ActionDurableObject-failures.md](ActionDurableObject-failures.md).

- `is not assignable to parameter of type 'Layer<Events | ObjectServer, never, never>'`, or `'Effect<Context<Events | ObjectServer>, never, never>'`, where the object builds `ObjectServer.layer`, the source naming `Alarm`, `Tasks` or `Waits`: the routes need the object's alarm, which a class serving them through `ObjectServer` does not run, such as `layerWebhooks`' routes; serve them with `ActionDurableObject.make` or `handlers`.
- `is not assignable to parameter of type 'Layer<Events | ObjectServer, never, never>'`, or `'Effect<Context<Events | ObjectServer>, never, never>'`, the source naming another service: the routes, or a handler at request time, require a service the Layer is not given; provide its Layer to `ObjectServer.layer(routes)`, with `ActionDurableObject.State`.
