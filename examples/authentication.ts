import { Effect, Option } from "effect";
import * as Authentication from "../src/Authentication.js";
import { actors, CurrentActor, Unauthenticated } from "./auth.js";

// RFC 9728 discovery, public: where a client learns which server issues its tokens.
export const discovery = Authentication.protectedResource({
  resource: "http://localhost:3000/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["users:read", "users:write"],
});

// DEMO ONLY: a token is an actor's name. Verify real tokens with your authorization
// server's library instead.
const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

// Provides CurrentActor per request. A refusal is a declared error: sent as its JSON with
// its `httpApiStatus` (401), plus the challenge. The binding declares it too, so what is
// sent is what clients decode.
export const authentication = Authentication.middleware(
  CurrentActor,
  Effect.flatMap(Authentication.bearerToken, (token) =>
    Option.isSome(token) && isActorToken(token.value)
      ? Effect.succeed(actors[token.value])
      : Effect.fail(new Unauthenticated({ message: "A demo bearer token is required." })),
  ),
  { errors: [Unauthenticated], headers: { "www-authenticate": discovery.challenge() } },
);
