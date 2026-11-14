import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";

import { CartRpc } from "./Rpc.js";

const byCart = (input: { readonly cart: string }) => input.cart;

export const Cart = ActionEntity.make("Cart", CartRpc, {
  key: { addItem: byCart, viewCart: byCart },
});
