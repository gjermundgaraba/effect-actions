import { Context, Effect, Schema } from "effect";
import { expectTypeOf } from "@effect/vitest";
import { HttpApiError } from "effect/http-api";
import * as Action from "../../src/contract/Action.js";

type TakesAuthorize = "A protected action takes { authorize }: your rule, or Action.allowAll";

class Actor extends Context.Service<Actor, { readonly id: string }>()("pin/Actor") {}

class Scopes extends Context.Service<Scopes, ReadonlySet<string>>()("pin/Scopes") {}

class Perms extends Context.Service<Perms, ReadonlySet<string>>()("pin/Perms") {}

const Get = Action.make("get", {
  description: "d",
  readOnly: true,
  caller: Actor,
  success: Schema.String,
});

declare const getWithTheSentence: typeof Get & TakesAuthorize;

declare const getWithAnother: typeof Get & "Another sentence";

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
  const effectFnAuthorizer = Action.implement([Get, Put, Open], handlers, {
    authorize: Effect.fn(function* (action) {
      expectTypeOf(action).toEqualTypeOf<typeof Get | typeof Put>();
      yield* Scopes;
    }),
  });

  expectTypeOf<(typeof effectFnAuthorizer)["~authorizeRequest"]>().toEqualTypeOf<Scopes>();

  const builtAuthorizer = Action.implement(
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

  expectTypeOf<(typeof builtAuthorizer)["~authorizeRequest"]>().toEqualTypeOf<Scopes>();

  expectTypeOf(builtAuthorizer).toEqualTypeOf<
    Action.Implementation<
      typeof Get | typeof Put,
      { readonly get: never; readonly put: never },
      never,
      never,
      Scopes,
      never,
      Perms
    >
  >();

  Action.implement([Open], { open: handlers.open });
  Action.implement(Open, handlers.open);
  // @ts-expect-error -- A public-only implementation takes no authorize.
  Action.implement([Open], { open: handlers.open }, { authorize: Action.allowAll });
  // @ts-expect-error -- Protected actions need authorize.
  Action.implement([Get], { get: handlers.get });
  Action.implement(getWithTheSentence, handlers.get);
  // @ts-expect-error -- The error of a call without `authorize` ends in that sentence, and in no other.
  Action.implement(getWithAnother, handlers.get);
  Action.implement([Get], { get: handlers.get }, { authorize: Action.allowAll });
  Action.implement(
    [Get],
    { get: handlers.get },
    {
      // @ts-expect-error -- Effect's `Forbidden` is no refusal: no refusal codec encodes it.
      authorize: () => Effect.fail(new HttpApiError.Forbidden({})),
    },
  );
};
