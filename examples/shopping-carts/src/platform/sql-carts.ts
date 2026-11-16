import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { CartStore } from "../cart/store.js";

const decodeItems = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ item: Schema.String }))
);

export const layerSqlCarts = Layer.effect(CartStore)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS cart_items (id INTEGER PRIMARY KEY AUTOINCREMENT, cart TEXT NOT NULL, item TEXT NOT NULL)`;

    return CartStore.of({
      items: (cart) =>
        sql`SELECT item FROM cart_items WHERE cart = ${cart} ORDER BY id`.pipe(
          Effect.flatMap(decodeItems),
          Effect.map((rows) => rows.map(({ item }) => item)),
          Effect.orDie
        ),
      add: (cart, item) =>
        sql`INSERT INTO cart_items (cart, item) VALUES (${cart}, ${item})`.pipe(
          Effect.asVoid,
          Effect.orDie
        ),
    });
  }).pipe(Effect.orDie)
);
