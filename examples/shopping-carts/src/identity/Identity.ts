import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Context } from "effect";

export interface Shopper {
  readonly id: string;
}

export class CurrentShopper extends Context.Service<CurrentShopper, Shopper>()(
  "shopping-carts/CurrentShopper"
) {}

export const Login = Authentication.make(
  "shopping-carts.Login",
  CurrentShopper,
  { principal: (shopper) => shopper.id }
);
