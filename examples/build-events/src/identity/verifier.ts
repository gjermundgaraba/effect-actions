import { Effect, Redacted } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Login } from "./Identity.js";
import { members } from "./members.js";

const isMember = (token: string): token is keyof typeof members => Object.hasOwn(members, token);

// DEMO ONLY: a token is a member's name. A real verifier checks a signed token with your
// authorization server's library. An unknown token is the built-in `Unauthenticated`, which
// every client decodes, a watch's included.
export const authenticate = Authentication.layer(Login, (token) => {
  const name = Redacted.value(token);

  return isMember(name)
    ? Effect.succeed(members[name])
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
});
