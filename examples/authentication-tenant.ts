import { Context, Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Action from "../src/Action.js";
import * as Authentication from "../src/Authentication.js";
import { type Actor, actors, CurrentActor } from "./authorization.js";

/** Each request's tenant: the first label of its host, `acme` for acme.example.com. */
export class Tenant extends Context.Service<Tenant, string>()("example/Tenant") {}

const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.provideService(route, Tenant, request.headers.host?.split(".")[0] ?? ""),
  ),
);

// Reads the identity: names the authenticated caller on each response.
const logCaller = HttpRouter.middleware()((route) =>
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
const authentication = Authentication.make(
  CurrentActor,
  Effect.gen(function* () {
    const verifier = yield* Verifier;

    return Effect.gen(function* () {
      const actor = yield* verifier.verify(yield* Authentication.bearerToken);

      if (actor.tenantId !== (yield* Tenant)) {
        return yield* new Action.Forbidden({ message: "Not a member of this tenant." });
      }

      return actor;
    });
  }),
);

// `resolveTenant` runs first, providing what the authentication reads; `logCaller` runs
// last, reading the identity the authentication provides.
export const authenticate = logCaller
  .combine(authentication.combine(resolveTenant))
  .layer.pipe(Layer.provide(Verifier.layer));
