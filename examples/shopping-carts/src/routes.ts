import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect, Layer } from "effect";
import { Entity } from "effect/cluster";

import { CartHttp } from "./Api.js";
import { carts } from "./cart/handlers.js";
import { CurrentCart } from "./cart/held.js";
import { Cart } from "./entities.js";
import { authenticate } from "./identity/verifier.js";
import { layerSqlCarts } from "./platform/sql-carts.js";

const cartOfAddress = Layer.effect(CurrentCart)(
  Effect.map(Entity.CurrentAddress, ({ entityId }) => entityId)
);

export const entities = ActionEntity.layer(Cart, carts, {
  services: cartOfAddress,
}).pipe(Layer.provide([authenticate, layerSqlCarts]));

export const routes = ActionHttp.layer(
  CartHttp,
  ActionEntity.reaching(Cart)
).pipe(Layer.provide(authenticate));
