import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Effect, Redacted } from "effect";

import { actors } from "./authorization.js";
import type { Actor } from "./authorization.js";
import { Login } from "./binding.js";

const isActorToken = (token: string): token is keyof typeof actors =>
  Object.hasOwn(actors, token);

export const verify = (
  token: Redacted.Redacted
): Effect.Effect<Actor, Action.Unauthenticated> => {
  const name = Redacted.value(token);

  return isActorToken(name)
    ? Effect.succeed(actors[name])
    : Effect.fail(
        new Action.Unauthenticated({ message: "Unknown demo token." })
      );
};

export const protectedResource = {
  resource: "http://localhost:3000/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["users:read", "users:write"],
  scopesRequired: ["users:read"],
} satisfies Authentication.ProtectedResource;

export const authenticate = Authentication.layer(Login, verify, {
  protectedResource,
});
