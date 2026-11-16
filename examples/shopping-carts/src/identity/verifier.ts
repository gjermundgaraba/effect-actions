import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Effect, Redacted } from "effect";

import { Login } from "./Identity.js";
import { demoShoppers } from "./shoppers.js";

const isToken = (token: string): token is keyof typeof demoShoppers =>
  Object.hasOwn(demoShoppers, token);

const demoVerify = (token: Redacted.Redacted) => {
  const name = Redacted.value(token);

  return isToken(name)
    ? Effect.succeed(demoShoppers[name])
    : Effect.fail(
        new Action.Unauthenticated({ message: "Unknown demo token." })
      );
};

export const authenticate = Authentication.layer(Login, demoVerify);
