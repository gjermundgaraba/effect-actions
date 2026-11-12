# ActionEntity failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message. The tasks are in [ActionEntity.md](ActionEntity.md).

- `Property '<name>' is missing in type` on `ActionEntity.make`'s `key`: the binding holds an action or event type with no key. Add a function reading its entity id from its input, under its name.
- `"An entity serves no native rpcs"` in a type error on `ActionEntity.make`: the binding was made with `rpcs`. Bind the actions alone, and serve the native rpcs from an `Entity` of their own.
- `Service not found: effect/http/HttpRouter` as the entity builds: its authentication provider publishes a `protectedResource`, on a router an entity lacks. Give the provider serving the entity no `protectedResource`.
- `Defect building entity handlers`, logged again and again while calls wait: an implementation's builder fails or dies, or reads a service the layer was not given. Fix the builder, or provide the service to `ActionEntity.layer`.
- A test of an entity on `TestRunner.layer` that never ends, under `it.effect`: the cluster waits on a clock that `TestClock` holds still. Run it with `it.live`.
- `Entity.makeTestClient: <type> was not registered by layer`, Effect's own error: the layer given registers another entity. Give it `ActionEntity.layer` of the same entity.
