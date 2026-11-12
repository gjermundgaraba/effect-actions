# ActionEntity failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message. The tasks are in [ActionEntity.md](ActionEntity.md).

- `Property '<name>' is missing in type` on `ActionEntity.make`'s `key`: the binding holds an action or event type with no key. Add a function reading its entity id from its input, under its name.
- `"An entity serves no native rpcs"` in a type error on `ActionEntity.make`: the binding was made with `rpcs`. Bind the actions alone, and serve the native rpcs from an `Entity` of their own.
- `An entity provides no service per call` in a type error on `ActionEntity.layer`: a handler, an authorizer or an event source reads per call a service other than its caller, named in the diagnostic. Yield it in the implementation's builder, where the layer requires it at startup.
- `Service not found: effect/http/HttpRouter`, a defect as `ActionEntity.layer` builds, before any call: its authentication provider publishes a `protectedResource`, on a router an entity lacks. Give the provider serving the entity no `protectedResource`.
- `Defect building entity handlers`, logged again and again while calls wait: an implementation's builder fails or dies, or reads a service the layer was not given. Fix the builder, or provide the service to `ActionEntity.layer`.
- `A test is using time, but is not advancing the test clock`, Effect's warning, then `Test timed out`: a test of an entity on `TestRunner.layer` under `it.effect`, whose cluster waits on a clock that `TestClock` holds still. Run it with `it.live`.
- `Entity.makeTestClient: <type> was not registered by layer`, Effect's own error: the layer given registers another entity. Give it `ActionEntity.layer` of the same entity.
