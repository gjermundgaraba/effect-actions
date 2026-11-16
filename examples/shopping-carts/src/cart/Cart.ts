import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";

import { CurrentShopper } from "../identity/Identity.js";

export const cartLimit = 10;

export class CartFull extends Schema.TaggedError<
  CartFull,
  { readonly brand: unique symbol }
>()(
  "CartFull",
  { cart: Schema.String, limit: Schema.Int },
  { httpApiStatus: 409 }
) {}

const inCart = {
  cart: Schema.String.annotate({
    description: "The cart's id, which is its shopper's id.",
  }),
};

const items = { items: Schema.Array(Schema.String) };

const signedIn = { caller: CurrentShopper } as const;

export const AddItem = Action.make("addItem", {
  ...signedIn,
  description: `Add an item to the cart, which holds at most ${cartLimit}.`,
  input: {
    ...inCart,
    item: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  },
  success: items,
  error: CartFull,
  readOnly: false,
});

export const ViewCart = Action.make("viewCart", {
  ...signedIn,
  description: "List the cart's items, oldest first.",
  input: inCart,
  success: items,
  readOnly: true,
});

export const Carts = [AddItem, ViewCart] as const;
