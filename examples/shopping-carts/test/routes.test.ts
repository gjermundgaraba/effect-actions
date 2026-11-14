import { SqliteClient } from "@effect/sql-sqlite-node";
import { expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Layer } from "effect";
import { TestRunner } from "effect/cluster";
import { HttpClient, HttpClientRequest } from "effect/http";

import { CartHttp } from "../src/Api.js";
import { cartLimit } from "../src/cart/Cart.js";
import { entities, routes } from "../src/routes.js";

const server = Testing.layer(routes).pipe(
  Layer.provideMerge(entities),
  Layer.provide(TestRunner.layer),
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

it.live("refuses an item past the cart's limit with CartFull", () =>
  Effect.gen(function* () {
    const ada = yield* shopperAs("ada");
    const items = Array.from({ length: cartLimit }, (_, n) => `item ${n}`);

    yield* Effect.forEach(items, (item) => ada.addItem({ cart: "ada", item }), {
      concurrency: "unbounded",
    });

    const full = yield* Effect.flip(ada.addItem({ cart: "ada", item: "more" }));

    expect(full).toMatchObject({ _tag: "CartFull", limit: cartLimit });
    expect((yield* ada.viewCart({ cart: "ada" })).items).toHaveLength(
      cartLimit
    );
  }).pipe(Effect.provide(server))
);
