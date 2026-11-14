# ActionEntity

`ActionEntity` serves an [RPC binding](ActionRpc.md) as an Effect Cluster entity. An entity type is a kind of stateful object, such as a chat room, and an entity id names one of them, such as the room `lobby`. The cluster's `Sharding` runs each entity id in one place at a time, on whatever runtime provides it: a Node or SQL cluster, `TestRunner` in a test, or a host that runs one entity per object. Each call reaches the entity its input names, and that entity builds its own handlers.

The example is [shopping-carts](../examples/shopping-carts/), carts on one process over SQLite; the Cloudflare package's chat-rooms runs the same model on Durable Objects. A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [ActionEntity-failures.md](ActionEntity-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`.

## Define an entity

Bind the actions and event types with `ActionRpc.make`, as for any RPC server ([ActionRpc.md](ActionRpc.md#bind-actions-to-rpcs)), then give `ActionEntity.make` the entity type's name, the binding, and a `key` for each action and event type. A key reads the entity id from the input, such as `({ room }) => room`, so every contract of an entity names its entity in its input. A contract without a key is a type error.

```ts example=shopping-carts/src/entities.ts
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";

import { CartRpc } from "./Rpc.js";

const byCart = (input: { readonly cart: string }) => input.cart;

export const Cart = ActionEntity.make("Cart", CartRpc, {
  key: { addItem: byCart, viewCart: byCart },
});
```

Each action is an rpc of the entity, named after it. Each event type is a unary rpc named `<event>/poll`, which answers the occurrences past a cursor, as an HTTP poll does, and `ActionRpc.layer` serves under the same name. The entity is Effect's own `Entity`, so `Entity.makeTestClient` and the rest of Effect's cluster functions take it. What its rpcs send, and why none of its actions' and event types' rpcs is persisted, is on `ActionEntity.make`.

An entity may also serve native rpcs of its own, given to `make` as `rpcs`: tells the entity or another entity sends through Effect's `Entity.client`, such as a persisted one annotated `ClusterSchema.Persisted` that the entity sends itself to run later, at the time its payload's `DeliverAt` names. They authenticate nothing, so no surface serves them.

## Serve it

`ActionEntity.layer(entity, implementations)` registers the entity with `Sharding`. The implementations are those of the binding's actions and event types, one or a list, as on every surface ([Action.md](Action.md#implement-actions)), and they must cover the whole binding. Provide the layer with what the implementations read at startup, the authentication provider of the binding's descriptor ([Authentication.md](Authentication.md#verify-credentials)), `Event.Events` when the binding has event types, and the cluster's `Sharding`.

Each entity id builds the implementations itself, when the cluster first sends it a message, and shares no build with `Action.layer` provided above it. State an implementation's builder holds belongs to that one entity, and a builder may read `Entity.CurrentAddress` for the id it serves. A service provided to the layer is built once per runner and shared by every entity id on it.

What each entity id must build for itself, such as a store over its own database or `Event.Events` kept there by `Stored.layerEvents`, goes in the layer's `services` option: each entity id builds it as it activates, before its implementations' builders, which read it. The handlers of `make`'s native rpcs go in the layer's `rpcs` option, as Effect's `Entity.toLayer` takes them: each receives Effect's own `Entity.Request`, and an Effect building them runs after `services`, whose output it reads.

An entity provides nothing per call but the caller, so a handler, an authorizer or an event source reading any other service per call is a type error naming it: yield the service in the builder, where it is a startup service. The rules, and what a defect does, are on `ActionEntity.layer`.

The example's carts build `CurrentCart` from the entity's address in `services`, and read their items from a store, which the entrypoint provides to the layer, so no state lives in the entity between calls, and the cluster may stop it while idle:

```ts example=shopping-carts/src/routes.ts
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect, Layer } from "effect";
import { Entity } from "effect/cluster";

import { CartHttp } from "./Api.js";
import { carts } from "./cart/handlers.js";
import { CurrentCart } from "./cart/held.js";
import { Cart } from "./entities.js";
import { authenticate } from "./identity/verifier.js";

const cartOfAddress = Layer.effect(CurrentCart)(
  Effect.map(Entity.CurrentAddress, ({ entityId }) => entityId)
);

export const entities = ActionEntity.layer(Cart, carts, {
  services: cartOfAddress,
}).pipe(Layer.provide(authenticate));

export const routes = ActionHttp.layer(
  CartHttp,
  ActionEntity.reaching(Cart)
).pipe(Layer.provide(authenticate));
```

Its [server.ts](../examples/shopping-carts/src/server.ts) runs both on Effect's `SingleRunner` over one SQLite file.

A protected action authenticates each call from the headers its envelope carries, as an RPC message does. Then the input decodes, and an input whose key names another entity is refused with `Forbidden` before the implementation's `authorize` runs.

## Call it

`ActionEntity.client(entity)` is Effect's `Entity.client` with one typed method per action: `(yield* ActionEntity.client(Room))("lobby").postMessage(input)`. Send credentials by setting headers with `RpcClient.withHeaders` around a call. The id must be the one the input's key names. What a call fails with is `ActionEntity.MethodError`, and the transport rules are on `ActionEntity.client`.

## Reach it from any surface

`ActionEntity.reaching(entity)` returns implementations of the entity's actions and event types that any surface serves beside its own, `ActionHttp.layer`, `ActionRpc.layer` or `ActionMcp.layerHttp`, given a binding of the same contracts: each call goes through `Entity.client` to the entity its input's key names, with the caller's headers, so one HTTP or MCP endpoint serves every room. The example's `routes` above serve every cart that way.

The surface authenticates a protected call with its own binding's descriptor and the entity authenticates it again, so provide the authentication provider to both.

An event is followed through the entity's poll rpc, so no watcher holds an entity open; a stream polls it from the surface. What crosses the two hops, and what does not, is on `ActionEntity.reaching`.

A server outside the cluster that forwards a socket's calls into the entity, as the Cloudflare package's socket host does, forwards the rpcs of `ActionEntity.bindingRpcs(entity)` alone, never the entity's native rpcs, which authenticate nothing; its clients call them with `ActionRpc.client(binding, { delivery: "poll" })`.

## Watch an event

The client's `watch(event, input, options)` follows an event by polling its rpc, from a cursor or from now, as `Action.client`'s does. An entity holds no stream open for a watcher, so a runtime that puts an idle entity to sleep can still do so. A watch asking for `mode: "stream"` fails with `Event.SubscriptionError`. What else ends a watch is on `ActionEntity.WatchError`.

## Deliver its events by webhook

A protected event served through `ActionEntity.reaching` is offered webhook delivery ([Webhook.md](Webhook.md)), held by the entity its input's key names: the surface sends each subscribe and unsubscribe there with the caller's headers, and the entity delivers from the `Webhook.layer` in its layer's `services`. An entity without one refuses the subscribe as `Unsupported`.

Give that layer `persist`, so a later activation of the entity restores its subscriptions, each entity id its own, which needs the binding's authentication to name a `schema`, and `ActionEntity.layerClock`, so a wait of 10 seconds or more is a persisted tell the entity sends itself and the runtime may stop the entity until it is due. Mark a check source over the entity's own store `notified`, whose deliveries then wait for its `notify` alone, on no timer that would keep a Durable Object awake, as a current source's always do. What the rpcs carrying a subscription are, and why they are not persisted, is on `ActionEntity.make`; the rules for the layer are on `ActionEntity.LayerOptions`' `services`.

## Test it

Provide the layer with `TestRunner.layer`, the in-memory cluster, and call it through `ActionEntity.client`. A `TestRunner` keeps real time, so run such a test with `it.live`, not `it.effect`. `Entity.makeTestClient` runs the entity with no runner, and its client speaks the rpcs' JSON rather than typed methods. The example's test serves its routes over `Testing.layer` and its entity on `TestRunner`, each test on a fresh in-memory database:

```ts example=shopping-carts/test/routes.test.ts
import { SqliteClient } from "@effect/sql-sqlite-node";
import { expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Layer, Result } from "effect";
import { TestRunner } from "effect/cluster";
import { HttpClient, HttpClientRequest } from "effect/http";

import { CartHttp } from "../src/Api.js";
import { cartLimit } from "../src/cart/Cart.js";
import { layerSqlCarts } from "../src/platform/sql-carts.js";
import { entities, routes } from "../src/routes.js";

const server = Testing.layer(routes).pipe(
  Layer.provideMerge(entities),
  Layer.provide([TestRunner.layer, layerSqlCarts]),
  Layer.provide(Layer.orDie(SqliteClient.layer({ filename: ":memory:" })))
);

const shopperAs = (token: string) =>
  ActionHttp.client(CartHttp, {
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(token)
    ),
  });

it.live("keeps each cart in the entity its id names, its own shopper's", () =>
  Effect.gen(function* () {
    const ada = yield* shopperAs("ada");
    const grace = yield* shopperAs("grace");

    yield* ada.addItem({ cart: "ada", item: "tea" });
    yield* grace.addItem({ cart: "grace", item: "milk" });

    expect(yield* ada.viewCart({ cart: "ada" })).toStrictEqual({
      items: ["tea"],
    });

    const refused = yield* Effect.flip(
      grace.addItem({ cart: "ada", item: "salt" })
    );

    expect(refused._tag).toBe("Forbidden");
    expect(yield* grace.viewCart({ cart: "grace" })).toStrictEqual({
      items: ["milk"],
    });
  }).pipe(Effect.provide(server))
);

it.live(
  "adds one item past the cart's limit nowhere, however many arrive at once",
  () =>
    Effect.gen(function* () {
      const ada = yield* shopperAs("ada");

      const added = yield* Effect.forEach(
        Array.from({ length: cartLimit + 1 }, (_, n) => `item ${n}`),
        (item) => Effect.result(ada.addItem({ cart: "ada", item })),
        { concurrency: "unbounded" }
      );

      expect(added.filter(Result.isFailure)).toMatchObject([
        { failure: { _tag: "CartFull", limit: cartLimit } },
      ]);
      expect((yield* ada.viewCart({ cart: "ada" })).items).toHaveLength(
        cartLimit
      );
    }).pipe(Effect.provide(server))
);
```
