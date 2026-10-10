import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { expectTypeOf } from "@effect/vitest";
import * as Authentication from "../../src/authentication/Authentication.js";

class Actor extends Context.Service<Actor, string>()("protect-types/Actor") {}

class Tenant extends Context.Service<Tenant, string>()("protect-types/Tenant") {}

const Login = Authentication.make("protect-types.Login", Actor);

type Owed<L> = L extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;

const own = HttpRouter.add(
  "GET",
  "/own",
  Effect.gen(function* () {
    const actor = yield* Actor;
    const tenant = yield* Tenant;

    return HttpServerResponse.text(`${actor}:${tenant}`);
  }),
);

export const protectTypes = () => {
  const concreteProvidesItsIdentityAlone = own.pipe(
    Layer.provide(Authentication.protect(Login).layer),
  );

  expectTypeOf<
    Extract<Owed<typeof concreteProvidesItsIdentityAlone>, HttpRouter.Request<"Requires", Actor>>
  >().toBeNever();
  expectTypeOf<
    Extract<Owed<typeof concreteProvidesItsIdentityAlone>, HttpRouter.Request<"Requires", Tenant>>
  >().not.toBeNever();

  const erased: Authentication.Any = Login;

  const erasedProvidesNothingNameable = own.pipe(
    Layer.provide(Authentication.protect(erased).layer),
  );

  expectTypeOf<
    Extract<Owed<typeof erasedProvidesNothingNameable>, HttpRouter.Request<"Requires", Tenant>>
  >().not.toBeNever();
};
