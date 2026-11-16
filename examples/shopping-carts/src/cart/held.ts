import { Context } from "effect";

export class CurrentCart extends Context.Service<CurrentCart, string>()(
  "shopping-carts/CurrentCart"
) {}
