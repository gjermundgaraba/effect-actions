import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Effect, Redacted } from "effect";

import { Login } from "./Identity.js";
import { demoMembers } from "./members.js";

const isMember = (token: string): token is keyof typeof demoMembers =>
  Object.hasOwn(demoMembers, token);

const demoVerify = (token: Redacted.Redacted) => {
  const name = Redacted.value(token);

  return isMember(name)
    ? Effect.succeed(demoMembers[name])
    : Effect.fail(
        new Action.Unauthenticated({ message: "Unknown demo token." })
      );
};

export const authenticate = Authentication.layer(Login, demoVerify);
