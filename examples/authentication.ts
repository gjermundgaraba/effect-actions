import { Effect, Redacted } from "effect";
import * as Action from "../src/Action.js";
import * as Authentication from "../src/Authentication.js";
import { actors, CurrentActor } from "./authorization.js";

// DEMO ONLY: a token is an actor's name. Verify real tokens with your authorization
// server's library instead.
const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

// Provides CurrentActor per request, to the routes of every layer it is provided to. A
// missing or unknown token is the built-in `Unauthenticated`: a 401 every client decodes.
// As an OAuth protected resource, it publishes RFC 9728 discovery, public, and every
// challenge names it, so an MCP client that was refused finds the server issuing its tokens.
// A first login requests read only; a write refused for its scope steps up.
export const authenticate = Authentication.make(
  CurrentActor,
  Effect.flatMap(Authentication.bearerToken, (token) => {
    const name = Redacted.value(token);

    return isActorToken(name)
      ? Effect.succeed(actors[name])
      : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." }));
  }),
  {
    resource: "http://localhost:3000/mcp",
    authorizationServers: ["https://auth.example.com"],
    scopesSupported: ["users:read", "users:write"],
    scopesRequired: ["users:read"],
  },
);
