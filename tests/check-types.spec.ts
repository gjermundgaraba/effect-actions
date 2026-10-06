// Compile-only pins: a check may read several request services and the call's own scope, and
// a check is implemented by its callback or by an effect building it.
import { Context, Effect, Layer, Schema, type Scope } from "effect";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../src/Action.js";

class Actor extends Context.Service<Actor, { readonly id: string }>()("checks/Actor") {}

class Tenant extends Context.Service<Tenant, { readonly id: string }>()("checks/Tenant") {}

class Boot extends Context.Service<Boot, true>()("checks/Boot") {}

class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {}) {}

class Limit extends Action.Check<Limit>()("checks/Limit", {
  error: Throttled,
  requires: [Actor, Tenant],
}) {}

// A callback, reading both declared services and acquiring within the call's scope.
export const plain = Action.check(Limit, (action) =>
  Effect.gen(function* () {
    expectTypeOf(action).toEqualTypeOf<Action.Any>();
    yield* Actor;
    yield* Tenant;
    yield* Effect.addFinalizer(() => Effect.void);

    return yield* Effect.fail(new Throttled());
  }),
);

expectTypeOf(plain).toEqualTypeOf<Layer.Layer<Limit>>();

// Built once: what builds it is the layer's.
export const built = Action.check(
  Limit,
  Effect.as(Boot, () => Effect.asVoid(Actor)),
);

expectTypeOf(built).toEqualTypeOf<Layer.Layer<Limit, never, Boot>>();

// @ts-expect-error `Boot` is not a declared request service.
export const bad = Action.check(Limit, () => Effect.asVoid(Boot));

const X = Action.make("x", {
  description: "x",
  access: "read",
  auth: "public",
  checks: [Limit],
  success: Schema.String,
});

const x = Action.implement(X, () => Effect.succeed("x"));

// A caller owes each call both declared services, and no `Scope`.
const c = Action.client(x);

expectTypeOf<Effect.Services<typeof c>>().toEqualTypeOf<Scope.Scope | Limit>();

export const call = Effect.gen(function* () {
  const client = yield* c;

  return client.x();
});

type Method = Effect.Success<typeof call>;

expectTypeOf<Effect.Services<Method>>().toEqualTypeOf<Actor | Tenant>();
