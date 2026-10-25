import { Effect, Redacted } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Login } from "./Identity.js";
import { members } from "./members.js";

const isToken = (token: string): token is keyof typeof members => Object.hasOwn(members, token);

// DEMO ONLY: a token is a member's name. A real verifier checks a signed token with your
// authorization server's library, its audience and expiry included: a socket keeps the token
// its page connected with, and this runs on every message, so an expired one is refused.
const verify = (token: Redacted.Redacted<string>) => {
  const name = Redacted.value(token);

  return isToken(name)
    ? Effect.succeed(members[name])
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
};

export const authenticate = Authentication.layer(Login, verify);
