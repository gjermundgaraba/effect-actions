import { Context } from "effect";
import type { Effect } from "effect";

export class CartStore extends Context.Service<
  CartStore,
  {
    readonly items: (cart: string) => Effect.Effect<readonly string[]>;
    readonly add: (cart: string, item: string) => Effect.Effect<void>;
  }
>()("shopping-carts/CartStore") {}
