import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";

import { Carts } from "./cart/Cart.js";
import { Login } from "./identity/Identity.js";

export const CartRpc = ActionRpc.make(Carts, { authentication: Login });
