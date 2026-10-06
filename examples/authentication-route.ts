import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Action from "../src/Action.js";
import * as Authentication from "../src/Authentication.js";
import { CurrentActor } from "./authorization.js";
import { Login } from "./binding.js";

// A route of the host's own beside the actions, authenticated as they are: the binding's
// descriptor's provider verifies the request and gives the route the actor. A refusal it
// fails with is answered as an action's, and a scope a caller lacks steps up under Bearer.
export const exportRoute = HttpRouter.add(
  "GET",
  "/export",
  Effect.gen(function* () {
    const actor = yield* CurrentActor;

    if (!actor.permissions.includes("users:read")) {
      return yield* new Action.Forbidden({
        message: "Requires users:read.",
        scopes: ["users:read"],
      });
    }

    return HttpServerResponse.text(`Users of ${actor.tenantId}.`);
  }),
).pipe(Layer.provide(Authentication.protect(Login).layer));
