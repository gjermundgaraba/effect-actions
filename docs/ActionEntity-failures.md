# ActionEntity failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message. The tasks are in [ActionEntity.md](ActionEntity.md).

- `An entity provides no service per call` in a type error on `ActionEntity.layer`: a handler, an authorizer or an event source reads per call a service other than its caller and `services`' output, named in the diagnostic. Yield it in the implementation's builder, where the layer requires it at startup, or build it in the layer's `services`. Where `services` already outputs it, and is written inline as a `Layer.merge` or another generic combinator's result, TypeScript infers its output too late: assign the layer to a `const` first.
- `Service not found: effect/http/HttpRouter`, a defect as `ActionEntity.layer` builds, before any call: its authentication provider publishes a `protectedResource`, on a router an entity lacks. Give the provider serving the entity no `protectedResource`.
- `Defect building entity handlers`, logged again and again while calls wait: an implementation's builder fails or dies, or reads a service the layer was not given. Fix the builder, or provide the service to `ActionEntity.layer`.
- `A test is using time, but is not advancing the test clock`, Effect's warning, then `Test timed out`: a test of an entity on `TestRunner.layer` under `it.effect`, whose cluster waits on a clock that `TestClock` holds still. Run it with `it.live`.
- `Entity.makeTestClient: <type> was not registered by layer`, Effect's own error: the layer given registers another entity. Give it `ActionEntity.layer` of the same entity.
