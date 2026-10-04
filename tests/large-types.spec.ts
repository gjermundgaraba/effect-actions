// Compile-only assertions over large implementations, included by `vp check`: a file of
// their own, checked beside the others rather than after them.
import { Effect, Schema } from "effect";
import { expectTypeOf } from "@effect/vitest";
import * as Action from "../src/Action.js";
import { type NumberedHandlers, type Numbering, Throttled } from "./numbered.js";

/** Sixty actions of four errors each. */
type Sixty = Numbering<60, 3>;

/** Four hundred actions of seven errors each. */
type FourHundred = Numbering<400, 6>;

export const largeHookTypes = (
  sixty: Sixty,
  sixtyHandlers: NumberedHandlers<Sixty>,
  fourHundred: FourHundred,
  fourHundredHandlers: NumberedHandlers<FourHundred>,
  fourHundredArray: ReadonlyArray<FourHundred[number]>,
) => {
  // A hook may fail with any error the actions declare: their union, linear in the actions.
  expectTypeOf<Effect.Error<ReturnType<Action.Before<Sixty[number]>>>>().toEqualTypeOf<
    Action.Refusal | Sixty[number]["errors"][number]["Type"]
  >();

  Action.implement(sixty, sixtyHandlers, Action.allowAll);
  Action.implement(sixty, sixtyHandlers, (action) =>
    action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden()),
  );
  Action.implement(sixty, sixtyHandlers, () => Effect.fail(new Throttled()));
  // Only the first action declares it: a call of any other is a defect at run time.
  Action.implement(sixty, sixtyHandlers, () => Effect.fail(Schema.TaggedStruct("0a", {}).make({})));
  // @ts-expect-error No action declares it.
  Action.implement(sixty, sixtyHandlers, () => Effect.fail(Schema.TaggedStruct("0z", {}).make({})));

  // Four hundred actions, listed as a tuple or an array, behind a hook written inline or
  // annotated `Action.Before`.
  const limit: Action.Before<FourHundred[number]> = () => Effect.fail(new Throttled());

  Action.implement(fourHundred, fourHundredHandlers, () => Effect.fail(new Throttled()));
  Action.implement(fourHundredArray, fourHundredHandlers, () => Effect.fail(new Throttled()));
  Action.implement(fourHundred, fourHundredHandlers, limit);
};
