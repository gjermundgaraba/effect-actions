import { expectTypeOf } from "@effect/vitest";
import { Effect, pipe, Schema } from "effect";

import * as Action from "../../src/contract/Action.js";

class Missing extends Schema.TaggedError<
  Missing,
  { readonly brand: unique symbol }
>()("NotFound", { id: Schema.String }) {}

class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()("Unavailable", {}) {}

class UncertainOutcome extends Schema.TaggedError<
  UncertainOutcome,
  { readonly brand: unique symbol }
>()("UncertainOutcome", {}) {}

class Undeclared extends Schema.TaggedError<
  Undeclared,
  { readonly brand: unique symbol }
>()("Undeclared", {}) {}

const Save = Action.make("save", {
  description: "Save",
  readOnly: false,
  caller: Action.Anyone,
  input: { key: Schema.String, value: Schema.String },
  success: Schema.String,
  progress: Schema.Finite,
  error: [Missing],
  idempotencyKey: "key",
});

const dataFirst = Action.withErrors(Save, [Unavailable, UncertainOutcome]);

const piped = pipe(Save, Action.withErrors([Unavailable, UncertainOutcome]));

expectTypeOf(dataFirst.error).toEqualTypeOf<
  readonly [
    ...(typeof Save)["error"],
    typeof Unavailable,
    typeof UncertainOutcome,
  ]
>();

expectTypeOf(piped).toEqualTypeOf(dataFirst);

expectTypeOf(dataFirst.name).toEqualTypeOf<"save">();

expectTypeOf(dataFirst.input).toEqualTypeOf(Save.input);

expectTypeOf(dataFirst.success).toEqualTypeOf(Save.success);

expectTypeOf(dataFirst.progress).toEqualTypeOf(Save.progress);

expectTypeOf(dataFirst.readOnly).toEqualTypeOf<false>();

expectTypeOf(dataFirst.caller).toEqualTypeOf(Save.caller);

expectTypeOf(dataFirst.idempotencyKey).toEqualTypeOf<"key">();

expectTypeOf<(typeof dataFirst)["error"][number]["Type"]>().toEqualTypeOf<
  Missing | Unavailable | UncertainOutcome
>();

Action.implement(dataFirst, ({ key }) =>
  key === "" ? Effect.fail(new UncertainOutcome()) : Effect.succeed(key)
);

Action.implement(
  dataFirst,
  // @ts-expect-error -- A handler may fail only with the declared errors, the added ones among them.
  () => Effect.fail(new Undeclared())
);

Action.implement(
  Save,
  // @ts-expect-error -- The action it was made from declares none of the added errors.
  () => Effect.fail(new Unavailable())
);
