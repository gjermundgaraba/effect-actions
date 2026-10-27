import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Effect, Redacted } from "effect";

import { Login } from "./Identity.js";
import { members } from "./members.js";

const isToken = (token: string): token is keyof typeof members =>
  Object.hasOwn(members, token);

// DEMO ONLY: a token is a member's name. A real verifier checks a signed token with your
// authorization server's library, its audience included. An unknown token is the built-in
// `Unauthenticated`, which every client decodes.
const verify = (token: Redacted.Redacted) => {
  const name = Redacted.value(token);

  return isToken(name)
    ? Effect.succeed(members[name])
    : Effect.fail(
        new Action.Unauthenticated({ message: "Unknown demo token." })
      );
};

// Server only: `Login`'s provider. Over RPC it runs for every message of a protected rpc, not
// once for the connection, so a socket has no identity of its own: each call is whoever its
// token says. It publishes no OAuth discovery, so it needs no router and no configuration.
export const authenticate = Authentication.layer(Login, verify);
