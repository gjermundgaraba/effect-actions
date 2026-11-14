import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";

import { CartRpc } from "./Rpc.js";

export const Cart = ActionEntity.make("Cart", CartRpc, {
  key: ({ cart }) => cart,
});
