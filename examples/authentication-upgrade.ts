import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import * as Action from "../src/Action.js";
import * as Authentication from "../src/Authentication.js";
import { protectedResource, verify } from "./authentication.js";
import type { Actor } from "./authorization.js";

// A caller the router never routes, such as a Node `upgrade` handler admitting a socket,
// which authenticates the `Authorization` header itself: read as a route's is, with
// `bearerTokenOf`, and verified by the routes' own `verify`. A socket writes, so it needs the
// write scope. It gives the actor, or the response to refuse with, the one authentication
// answers the same refusal with on a route.
export const admit = (authorization: string | undefined): Effect.Effect<Actor, Response> =>
  Effect.fromOption(
    Authentication.bearerTokenOf(authorization),
    () => new Action.Unauthenticated(),
  ).pipe(
    Effect.flatMap(verify),
    Effect.filterOrFail(
      (actor) => actor.permissions.includes("users:write"),
      () => new Action.Forbidden({ message: "Requires users:write.", scopes: ["users:write"] }),
    ),
    Effect.mapError((error) =>
      HttpServerResponse.toWeb(Authentication.refusal(error, { protectedResource, authorization })),
    ),
  );
