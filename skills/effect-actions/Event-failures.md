# Event failure modes

What you see when something is wrong, and the fix. Search for a fragment of the message.
The tasks are in [Event.md](Event.md).

## At `implement`

- `is not assignable to parameter of type '... & "A protected event takes { authorize }: your rule, or Event.allowAll"'`: the list holds a protected event type, which takes `{ authorize }`. Give your rule, or `Event.allowAll`.
- `Type '{ authorize: ... }' is not assignable to type '{ readonly authorize?: "A public-only target takes no authorize" }'`: every event type in the list is public, and no authorizer runs for one. Remove `authorize`.
- `Object literal may only specify known properties, and 'log' does not exist`, or `Type '{}' is not assignable to type 'undefined'` at a source: it holds both `check` and `log`. Keep one: `check` where a store can be asked what happened since a cursor, `log` where nothing else keeps the occurrences.
- `Parameter 'input' implicitly has an 'any' type` at a check, a `match` or a `transform`: the builder is wrapped, as in `Effect.gen(…).pipe(Effect.provide(layer))`, and its sources are no longer typed from the contracts. Give `implement` the builder itself.

## At `watch`

- `Property 'watch' does not exist on type`: the client was given no event implementation. Pass the event implementations beside the action ones, `Action.client([builds, buildEvents])`.
- `Argument of type 'Event<...>' is not assignable to parameter of type` at `watch`: the client holds no implementation of that event type. Add its implementation to the list.
