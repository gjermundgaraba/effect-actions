import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Config, Effect, Redacted } from "effect";

import { Login, scopes } from "./Identity.js";
import { demoUsers } from "./users.js";

const isToken = (token: string): token is keyof typeof demoUsers =>
  Object.hasOwn(demoUsers, token);

const verify = (token: Redacted.Redacted) => {
  const name = Redacted.value(token);

  return isToken(name)
    ? Effect.succeed(demoUsers[name])
    : Effect.fail(
        new Action.Unauthenticated({ message: "Unknown demo token." })
      );
};

export const authenticate = Authentication.layer(Login, verify, {
  protectedResource: Effect.map(
    Config.String("PUBLIC_URL").pipe(
      Config.withDefault("http://localhost:3000")
    ),
    (url) =>
      ({
        resource: `${url}/mcp`,
        authorizationServers: ["https://auth.example.com"],
        scopesSupported: [scopes.read, scopes.write],
        scopesRequired: [scopes.read],
      }) satisfies Authentication.ProtectedResource
  ),
});
