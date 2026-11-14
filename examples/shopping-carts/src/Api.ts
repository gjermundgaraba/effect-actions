import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";

import { Carts } from "./cart/Cart.js";
import { Login } from "./identity/Identity.js";

export const CartHttp = ActionHttp.make(Carts, {
  prefix: "/api",
  authentication: Login,
});
