import { Effect, Redacted } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { type Actor, actors } from "./authorization.js";
import { Login } from "./binding.js";

// DEMO ONLY: a token is an actor's name. Verify real tokens with your authorization
// server's library instead, their audience included: issued for this resource.
const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

// Each request's token, as the native `HttpApiSecurity.bearer` decodes it, to its actor. A
// missing or empty token never reaches it; an unknown one is the built-in `Unauthenticated`,
// a 401 every client decodes, as is a missing one.
export const verify = (
  token: Redacted.Redacted<string>,
): Effect.Effect<Actor, Action.Unauthenticated> => {
  const name = Redacted.value(token);

  return isActorToken(name)
    ? Effect.succeed(actors[name])
    : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
};

// As an OAuth protected resource, it publishes RFC 9728 discovery, public, and every challenge
// names it, so an MCP client that was refused finds the server issuing its tokens. A first
// login requests read only; a write refused for its scope steps up.
export const protectedResource = {
  resource: "http://localhost:3000/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["users:read", "users:write"],
  scopesRequired: ["users:read"],
} satisfies Authentication.ProtectedResource;

// Server-only: `Login`'s verifier, provided to every layer serving protected actions. An
// Effect building it instead yields startup services, such as a token verifier, as a handler
// builder does; this demo needs none.
export const authenticate = Authentication.layer(Login, verify, {
  protectedResource,
});
