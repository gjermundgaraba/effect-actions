import { Config, Effect, Redacted } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Login, scopes } from "./Identity.js";
import { users } from "./users.js";

const isToken = (token: string): token is keyof typeof users => Object.hasOwn(users, token);

// DEMO ONLY: a token is a user's name. A real verifier checks a signed token with your
// authorization server's library, its audience included. An unknown token is the built-in
// `Unauthenticated`: a 401 every client decodes.
const verify = (token: Redacted.Redacted<string>) => {
  const name = Redacted.value(token);

  return isToken(name)
    ? Effect.succeed(users[name])
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
};

// Server only: `Login`'s provider. Every layer serving a protected action requires it and
// authenticates before it decodes the input. As an OAuth protected resource it also publishes
// discovery, so an MCP client that gets a 401 finds where to sign in, asking for read first.
// The resource is the server's public URL, known only at startup, so it is read from config.
export const authenticate = Authentication.layer(Login, verify, {
  protectedResource: Effect.map(
    Config.String("PUBLIC_URL").pipe(Config.withDefault("http://localhost:3000")),
    (url) =>
      ({
        resource: `${url}/mcp`,
        // DEMO ONLY: no server is there. Yours is your authorization server's issuer.
        authorizationServers: ["https://auth.example.com"],
        scopesSupported: [scopes.read, scopes.write],
        scopesRequired: [scopes.read],
      }) satisfies Authentication.ProtectedResource,
  ),
});
