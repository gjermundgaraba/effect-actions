import { Context, Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { type Actor, actors, CurrentActor } from "./authorization.js";
import { Http, Login } from "./binding.js";
import { userActions } from "./handlers.js";

/** Each request's tenant: the first label of its host, `acme` for acme.example.com. */
export class Tenant extends Context.Service<Tenant, string>()("example/Tenant") {}

// Outer: native router middleware, providing what the verifier reads per request.
const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.provideService(route, Tenant, request.headers.host?.split(".")[0] ?? ""),
  ),
);

// Inner: reads the identity, so it is native endpoint middleware, which the layer runs inside
// the authentication of every route it serves, all of them protected.
export class LogCaller extends HttpApiMiddleware.Service<LogCaller, { requires: CurrentActor }>()(
  "example/LogCaller",
) {}

const LogCallerLive = Layer.succeed(LogCaller, (route) =>
  Effect.flatMap(CurrentActor, ({ id }) =>
    Effect.map(route, HttpServerResponse.setHeader("x-actor", id)),
  ),
);

/** DEMO ONLY: a startup service verifying tokens, as your authorization server's library would. */
export class Verifier extends Context.Service<
  Verifier,
  {
    readonly verify: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<Actor, Action.Unauthenticated>;
  }
>()("example/Verifier") {
  static readonly layer = Layer.sync(Verifier, () => {
    const known = new Map<string, Actor>(Object.entries(actors));

    return Verifier.of({
      verify: (token) =>
        Effect.fromNullishOr(known.get(Redacted.value(token))).pipe(
          Effect.mapError(() => new Action.Unauthenticated({ message: "Unknown demo token." })),
        ),
    });
  });
}

// Like a handler builder: the verifier once, at startup; the token and the tenant per
// request. An actor of another tenant is refused.
const authenticate = Authentication.layer(
  Login,
  Effect.gen(function* () {
    const verifier = yield* Verifier;

    return (token: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const actor = yield* verifier.verify(token);

        if (actor.tenantId !== (yield* Tenant)) {
          return yield* new Action.Forbidden({ message: "Not a member of this tenant." });
        }

        return actor;
      });
  }),
);

// Provided in order: each `Layer.provide` gives what the layers before it still owe, so
// `resolveTenant`, last, gives the Tenant the verifier reads per request. One array,
// `Layer.provide([authenticate, resolveTenant.layer])`, would leave it owed: an array's
// members provide to the routes, not to one another.
export const routes = ActionHttp.layer(Http, userActions, { middleware: [LogCaller] }).pipe(
  Layer.provide([authenticate, LogCallerLive]),
  Layer.provide(Verifier.layer),
  Layer.provide(resolveTenant.layer),
);
