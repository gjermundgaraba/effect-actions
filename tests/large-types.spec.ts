// Compile-only assertions over large implementations, included by `vp check`: a file of
// their own, checked beside the others rather than after them.
import { Effect, Schema } from "effect";
import { expectTypeOf } from "vite-plus/test";
import * as Action from "../src/Action.js";

/** The limit every action of the large fixtures declares. */
class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {}, { httpApiStatus: 429 }) {}

/** An error one action of the large fixtures declares alone. */
type Own<Tag extends string> = Schema.Codec<{ readonly _tag: Tag }>;

/** Three or six errors of action `I`'s own. */
type OwnErrors<I extends number> = {
  readonly 3: readonly [Own<`${I}a`>, Own<`${I}b`>, Own<`${I}c`>];
  readonly 6: readonly [
    Own<`${I}a`>,
    Own<`${I}b`>,
    Own<`${I}c`>,
    Own<`${I}d`>,
    Own<`${I}e`>,
    Own<`${I}f`>,
  ];
};

/** Action `I` of the large fixtures: `K` errors of its own, and the limit. */
type Numbered<I extends number, K extends 3 | 6> = Action.Action<
  `action${I}`,
  Action.Any["input"],
  Action.Any["success"],
  readonly [...OwnErrors<I>[K], typeof Throttled],
  "read"
>;

/** Actions `0` to `N - 1`, of `K` errors of their own each. */
type Numbering<
  N extends number,
  K extends 3 | 6,
  Done extends ReadonlyArray<Action.Any> = [],
> = Done["length"] extends N
  ? Done
  : Numbering<N, K, readonly [...Done, Numbered<Done["length"], K>]>;

/** A handler for each of the actions `L`. */
type NumberedHandlers<L extends ReadonlyArray<Action.Any>> = {
  readonly [A in L[number] as A["name"]]: () => Effect.Effect<void>;
};

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
  // What every action declares is found one error at a time: an intersection of the sixty
  // unions would multiply out to 4^60 members, past what TypeScript represents (TS2590).
  expectTypeOf<Effect.Error<ReturnType<Action.Before<Sixty[number]>>>>().toEqualTypeOf<
    Action.Refusal | Throttled
  >();

  Action.implement(sixty, sixtyHandlers, Action.allowAll);
  Action.implement(sixty, sixtyHandlers, (action) =>
    action.access === "read" ? Effect.void : Effect.fail(new Action.Forbidden()),
  );
  Action.implement(sixty, sixtyHandlers, () => Effect.fail(new Throttled()));
  // @ts-expect-error Only the first action declares it.
  Action.implement(sixty, sixtyHandlers, () => Effect.fail(Schema.TaggedStruct("0a", {}).make({})));

  // `implement` filters only the first action's errors, among which is every error all the
  // actions declare: filtering every declared error against every action made this call too
  // deep to check (TS2589).
  Action.implement(fourHundred, fourHundredHandlers, () => Effect.fail(new Throttled()));
  // A list whose type fixes no first action, such as an array without `as const`, types its
  // actions only as their union: `implement` filters one member's errors. Filtering every
  // action's made this call too deep to check (TS2589).
  Action.implement(fourHundredArray, fourHundredHandlers, () => Effect.fail(new Throttled()));
};
