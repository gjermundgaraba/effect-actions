import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";

import { Carts } from "./cart/Cart.js";
import { Login } from "./identity/Identity.js";

export const Cart = ActionEntity.make("Cart", Carts, {
  authentication: Login,
  key: ({ cart }) => cart,
});
