// Compile-only pins on `implement`'s authorization: inferred from an `Effect.fn` or a built
// authorizer, required for protected actions, refused for public-only ones.
import { Context, Effect, Schema } from "effect";
import { expectTypeOf } from "@effect/vitest";
import { HttpApiError } from "effect/http-api";
import * as Action from "../src/Action.js";

class Actor extends Context.Service<Actor, { readonly id: string }>()("pin/Actor") {}

class Scopes extends Context.Service<Scopes, ReadonlySet<string>>()("pin/Scopes") {}

class Perms extends Context.Service<Perms, ReadonlySet<string>>()("pin/Perms") {}

const Get = Action.make("get", {
  description: "d",
  readOnly: true,
  caller: Actor,
  success: Schema.String,
});

const Put = Action.make("put", {
  description: "d",
  readOnly: false,
  caller: Actor,
  success: Schema.String,
});

const Open = Action.make("open", {
  description: "d",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

const handlers = {
  get: () => Effect.succeed("a"),
  put: () => Effect.succeed("b"),
  open: () => Effect.succeed("c"),
};

export const authorizeTypes = () => {
  // Effect.fn authorizer: action inferred as the protected union, RA from its yields.
  const a = Action.implement([Get, Put, Open], handlers, {
    authorize: Effect.fn(function* (action) {
      expectTypeOf(action).toEqualTypeOf<typeof Get | typeof Put>();
      yield* Scopes;
    }),
  });

  expectTypeOf<(typeof a)["~request"]["~authorize"]>().toEqualTypeOf<Scopes>();

  // Built authorizer: startup Perms, per-call Scopes.
  const b = Action.implement(
    [Get, Put],
    { get: handlers.get, put: handlers.put },
    {
      authorize: Effect.gen(function* () {
        yield* Perms;

        return (action) => {
          expectTypeOf(action).toEqualTypeOf<typeof Get | typeof Put>();

          return Effect.asVoid(Scopes);
        };
      }),
    },
  );

  expectTypeOf<(typeof b)["~request"]["~authorize"]>().toEqualTypeOf<Scopes>();
  // Public only: no authorize.
  Action.implement([Open], { open: handlers.open });
  Action.implement(Open, handlers.open);
  // @ts-expect-error A public-only implementation takes no authorize.
  Action.implement([Open], { open: handlers.open }, { authorize: Action.allowAll });
  // @ts-expect-error Protected actions need authorize.
  Action.implement([Get], { get: handlers.get });
  Action.implement([Get], { get: handlers.get }, { authorize: Action.allowAll });
  // A refusal is a built-in class: Effect's `Forbidden`, which no refusal codec encodes, is not one.
  Action.implement(
    [Get],
    { get: handlers.get },
    {
      // @ts-expect-error Effect's `Forbidden`.
      authorize: () => Effect.fail(new HttpApiError.Forbidden({})),
    },
  );
};
