# shopping-carts

Shopping carts as Effect Cluster entities: each cart is one entity id of the `Cart` entity, which runs in one place at a time and one call at a time. Shoppers add items to their own cart and list it over JSON routes, which reach the cart the input names through `ActionEntity.reaching`. The server is one process, Effect's `SingleRunner`, keeping the cluster's messages and the carts in one SQLite file. The same entities on Cloudflare Durable Objects are the Cloudflare package's chat-rooms example.

## Run it

From the repository root, after `vp install` (from an installed package, see [Run one](../README.md#run-one)):

```sh
node --import tsx examples/shopping-carts/src/server.ts     # 127.0.0.1:3000, writes shopping-carts.db
vp test examples/shopping-carts
```

Beside what [Run one](../README.md#run-one) lists, it needs `@effect/sql-sqlite-node`. The tokens are fixed names (`ada`, `grace`): replace them, and the database's path, before deploying anything.

## When you copy this

Each trap below is shown in the code of the files it names.

- **A cart is its entity's id, and its shopper's own**: the handlers and their rule read `CurrentCart`, which `routes.ts` builds from `Entity.CurrentAddress`, so another shopper's call reaches that cart and is refused: `src/cart/handlers.ts`, `src/routes.ts`.
- **A cart's limit needs no lock**: an entity id runs one call at a time, so reading the items and adding one never interleave: `src/cart/handlers.ts`.
- **The items live in the database, not in the entity**: the cluster stops an idle entity and builds it again for its next call: `src/platform/sql-carts.ts`.
- **One process, one runner**: a cluster of several processes uses Effect's other runners in place of `layerSingleRunner`: `src/platform/cluster.ts`, `src/server.ts`.

## Layout

```text
src/
├── cart/
│   ├── Cart.ts        contract: the actions and CartFull
│   ├── held.ts        CurrentCart, the cart an entity holds: a startup service
│   ├── store.ts       CartStore, the service the handlers call
│   └── handlers.ts    Action.implement: contract to store, and the one authorization rule
├── identity/
│   ├── Identity.ts    contract: CurrentShopper and the Login descriptor
│   ├── shoppers.ts    the demo shoppers
│   └── verifier.ts    Authentication.layer: tokens to shoppers, server only
├── platform/
│   ├── sql-carts.ts   CartStore over a SqlClient
│   └── cluster.ts     SingleRunner, the cluster in one process over that SqlClient
├── Api.ts             the HTTP binding
├── entities.ts        Cart, the entity: which cart each action's input names
├── routes.ts          the entity's layer, and the JSON routes reaching it
└── server.ts          entrypoint: both, with CartStore over SQL, on SingleRunner and one SQLite file
test/routes.test.ts    the routes and the entity, in memory on TestRunner
```
