import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { expectTypeOf } from "@effect/vitest";
import * as Authentication from "../src/Authentication.js";

class Actor extends Context.Service<Actor, string>()("protect-types/Actor") {}

class Tenant extends Context.Service<Tenant, string>()("protect-types/Tenant") {}

const Login = Authentication.make("protect-types.Login", Actor);

/** What a layer owes. */
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
  // A concrete descriptor provides its identity, and the route's other services stay owed.
  const concrete = own.pipe(Layer.provide(Authentication.protect(Login).layer));
  expectTypeOf<Extract<Owed<typeof concrete>, HttpRouter.Request<"Requires", Actor>>>().toBeNever();
  expectTypeOf<
    Extract<Owed<typeof concrete>, HttpRouter.Request<"Requires", Tenant>>
  >().not.toBeNever();

  // An erased descriptor's identity is `unknown`: it provides nothing the types can name,
  // rather than discharging every request service the route owes.
  const erased: Authentication.Any = Login;
  const anyLogin = own.pipe(Layer.provide(Authentication.protect(erased).layer));
  expectTypeOf<
    Extract<Owed<typeof anyLogin>, HttpRouter.Request<"Requires", Tenant>>
  >().not.toBeNever();
};
