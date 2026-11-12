# ActionEntity

`ActionEntity` serves an [RPC binding](ActionRpc.md) as an Effect Cluster entity. An entity type is a kind of stateful object, such as a chat room, and an entity id names one of them, such as the room `lobby`. The cluster's `Sharding` runs each entity id in one place at a time, on whatever runtime provides it: a Node or SQL cluster, `TestRunner` in a test, or a host that runs one entity per object. Each call reaches the entity its input names, and that entity builds its own handlers.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [ActionEntity-failures.md](ActionEntity-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`.

## Define an entity

Bind the actions and event types with `ActionRpc.make`, as for any RPC server ([ActionRpc.md](ActionRpc.md#bind-actions-to-rpcs)), then give `ActionEntity.make` the entity type's name, the binding, and a `key` for each action and event type. A key reads the entity id from the input, such as `({ room }) => room`, so every contract of an entity names its entity in its input. A contract without a key is a type error.

Each action is an rpc of the entity, named after it. Each event type is a unary rpc named after it, which answers the occurrences past a cursor, as an HTTP poll does. The entity is Effect's own `Entity`, so `Entity.makeTestClient` and the rest of Effect's cluster functions take it. What its rpcs send, and why none of them is persisted, is on `ActionEntity.make`.

## Serve it

`ActionEntity.layer(entity, implementations)` registers the entity with `Sharding`. The implementations are those of the binding's actions and event types, one or a list, as on every surface ([Action.md](Action.md#implement-actions)), and they must cover the whole binding. Provide the layer with what the implementations read at startup, the authentication provider of the binding's descriptor ([Authentication.md](Authentication.md#verify-credentials)), `Event.Events` when the binding has event types, and the cluster's `Sharding`.

Each entity id builds the implementations itself, when the cluster first sends it a message, and shares no build with `Action.layer` provided above it. State an implementation's builder holds belongs to that one entity, and a builder may read `Entity.CurrentAddress` for the id it serves. A service provided to the layer is built once per runner and shared by every entity id on it.

An entity provides nothing per call but the caller, so a handler, an authorizer or an event source reading any other service per call is a type error naming it: yield the service in the builder, where it is a startup service. The rules, and what a defect does, are on `ActionEntity.layer`.

A protected action authenticates each call from the headers its envelope carries, as an RPC message does. Then the input decodes, and an input whose key names another entity is refused with `Forbidden` before the implementation's `authorize` runs.

## Call it

`ActionEntity.client(entity)` is Effect's `Entity.client` with one typed method per action: `(yield* ActionEntity.client(Room))("lobby").postMessage(input)`. Send credentials by setting headers with `RpcClient.withHeaders` around a call. The id must be the one the input's key names. What a call fails with is `ActionEntity.MethodError`, and the transport rules are on `ActionEntity.client`.

## Reach it from any surface

`ActionEntity.reaching(entity)` returns implementations of the entity's actions and event types that any surface serves beside its own, `ActionHttp.layer`, `ActionRpc.layer` or `ActionMcp.layerHttp`, given a binding of the same contracts: each call goes through `Entity.client` to the entity its input's key names, with the caller's headers, so one HTTP or MCP endpoint serves every room.

The surface authenticates a protected call with its own binding's descriptor and the entity authenticates it again, so provide the authentication provider to both.

An event is followed through the entity's poll rpc, so no watcher holds an entity open; a stream polls it from the surface. An MCP endpoint served `requestScoped`, as on a serverless host, answers `events/poll` alone. What crosses the two hops, and what does not, is on `ActionEntity.reaching`.

## Watch an event

The client's `watch(event, input, options)` follows an event by polling its rpc, from a cursor or from now, as `Action.client`'s does. An entity holds no stream open for a watcher, so a runtime that puts an idle entity to sleep can still do so. A watch asking for `mode: "stream"` fails with `Event.SubscriptionError`. What else ends a watch is on `ActionEntity.WatchError`.

## Test it

Provide the layer with `TestRunner.layer`, the in-memory cluster, and call it through `ActionEntity.client`. A `TestRunner` keeps real time, so run such a test with `it.live`, not `it.effect`. `Entity.makeTestClient` runs the entity with no runner, and its client speaks the rpcs' JSON rather than typed methods.
