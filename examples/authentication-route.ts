import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Authentication from "../src/Authentication.js";
import { protectedResource, verify } from "./authentication.js";

// A route of the host's own beside the actions, which no authentication descriptor covers: it
// reads the bearer token itself, verifies it with the function `authenticate` verifies the
// actions' tokens with, and refuses as authentication refuses on an action's route.
export const exportRoute = HttpRouter.add(
  "GET",
  "/export",
  Effect.gen(function* () {
    const actor = yield* Effect.flatMap(Authentication.bearerToken, verify);

    return HttpServerResponse.text(`Users of ${actor.tenantId}.`);
  }).pipe(
    Effect.catch((error) =>
      Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
        Authentication.refusal(error, {
          protectedResource,
          authorization: request.headers.authorization,
        }),
      ),
    ),
  ),
);
