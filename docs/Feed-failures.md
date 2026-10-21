# Feed failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
A missing service's error can start
`… with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined'`: search the type it
names instead. The tasks are in [Feed.md](Feed.md).

- `Feed | Scope>' is not assignable to type 'Effect<` at `it.effect`, or `Layer<Protocol, never, Feed>' is not assignable` where a client's layer is built: a handler or a store yields `Feed`, which nothing provides. Provide `Feed.layer` once around the routes, beside the store, as the entrypoint does; `Testing.layer` provides none, and a Durable Object made with `make` or `handlers` is given `ActionDurableObject.layerFeed`.
