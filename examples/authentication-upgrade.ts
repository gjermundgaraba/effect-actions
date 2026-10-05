import { Effect, Option, Redacted } from "effect";
import { HttpServerResponse } from "effect/http";
import * as Action from "../src/Action.js";
import * as Authentication from "../src/Authentication.js";
import { type Actor, actors } from "./authorization.js";

// The protected resource `Authentication.make` is given around the routes.
const protectedResource = {
  resource: "http://localhost:3000/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopesSupported: ["users:read", "users:write"],
  scopesRequired: ["users:read"],
} satisfies Authentication.Options;

const isActorToken = (token: string): token is keyof typeof actors => Object.hasOwn(actors, token);

// DEMO ONLY: a token is an actor's name. A socket writes, so it needs the write scope. The
// header is read as a route's is: `bearerTokenOf` is what `bearerToken` reads a request with.
const verify = (authorization: string | undefined): Effect.Effect<Actor, Action.Refusal> => {
  const token = Option.getOrUndefined(
    Option.map(Authentication.bearerTokenOf(authorization), Redacted.value),
  );

  if (token === undefined || !isActorToken(token)) {
    return Effect.fail(new Action.Unauthenticated());
  }

  const actor: Actor = actors[token];

  return actor.permissions.includes("users:write")
    ? Effect.succeed(actor)
    : Effect.fail(
        new Action.Forbidden({ message: "Requires users:write.", scopes: ["users:write"] }),
      );
};

// A caller the router never routes, such as a Node `upgrade` handler admitting a socket,
// which authenticates the `Authorization` header itself: the actor, or the response to
// refuse with, the one the middleware answers the same refusal with on a route.
export const admit = (authorization: string | undefined): Effect.Effect<Actor, Response> =>
  Effect.mapError(verify(authorization), (error) =>
    HttpServerResponse.toWeb(Authentication.refusal(error, { protectedResource, authorization })),
  );
