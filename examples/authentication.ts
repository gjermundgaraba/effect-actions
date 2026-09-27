import { Effect } from "effect";
import * as Action from "../src/Action.js";
import * as Authentication from "../src/Authentication.js";
import { actors, CurrentActor } from "./authorization.js";

// RFC 9728 discovery, public: where an MCP client that was refused finds the server that
// issues its tokens.
export const discovery = Authentication.protectedResource({
  resource: "http://localhost:3000/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["users:read", "users:write"],
});

// DEMO ONLY: a token is an actor's name. Verify real tokens with your authorization
// server's library instead.
const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

// Provides CurrentActor per request, to the routes of every layer it is provided to. A
// missing or unknown token is the built-in `Unauthenticated`: a 401 every client decodes,
// with a `Bearer` challenge.
export const authenticate = Authentication.make(
  CurrentActor,
  Effect.flatMap(Authentication.bearerToken, (token) =>
    isActorToken(token)
      ? Effect.succeed(actors[token])
      : Effect.fail(new Action.Unauthenticated({ message: "Unknown demo token." })),
  ),
);
