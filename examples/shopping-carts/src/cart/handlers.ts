import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { CurrentShopper } from "../identity/Identity.js";
import { CartFull, cartLimit, Carts } from "./Cart.js";
import { CurrentCart } from "./held.js";
import { CartStore } from "./store.js";

const ownCart = Effect.map(CurrentCart, (cart) =>
  Effect.fn("ownCart")(function* () {
    const shopper = yield* CurrentShopper;

    if (shopper.id !== cart) {
      return yield* new Action.Forbidden({ message: "Not your cart." });
    }
  })
);

export const carts = Action.implement(
  Carts,
  Effect.gen(function* () {
    const cart = yield* CurrentCart;
    const store = yield* CartStore;

    return {
      addItem: ({ item }) =>
        Effect.gen(function* () {
          const items = yield* store.items(cart);

          if (items.length >= cartLimit) {
            return yield* new CartFull({ cart, limit: cartLimit });
          }

          yield* store.add(cart, item);

          return { items: [...items, item] };
        }),
      viewCart: () => Effect.map(store.items(cart), (items) => ({ items })),
    };
  }),
  { authorize: ownCart }
);
