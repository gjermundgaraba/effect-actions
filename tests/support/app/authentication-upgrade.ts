import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { protectedResource, verify } from "./authentication.js";
import type { Actor } from "./authorization.js";

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
      HttpServerResponse.toWeb(
        Authentication.refusalResponse(error, { protectedResource, authorization }),
      ),
    ),
  );
