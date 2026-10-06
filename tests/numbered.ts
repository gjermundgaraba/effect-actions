// The actions of the large fixtures, typed as `Action.make` types them: as many as a fixture
// lists, each declaring errors of its own and the limit every one of them shares.
import { Context, type Effect, Schema } from "effect";
import * as Action from "../src/Action.js";

/** The caller of the large fixtures' protected actions. */
export class Caller extends Context.Service<Caller, string>()("numbered/Caller") {}

/** The limit every action of the large fixtures declares. */
export class Throttled extends Schema.TaggedError<Throttled>()(
  "Throttled",
  {},
  { httpApiStatus: 429 },
) {}

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

/**
 * Action `I` of the large fixtures, as `make` types it: `K` errors of its own, the limit they
 * share, and `Caller`, who may call it. The identity is written here rather
 * than passed through `Numbering` as a parameter: carried as a type argument, a class's
 * type doubles the fixtures' instantiations, a cost no contract `make` returns has.
 */
type Numbered<I extends number, K extends 3 | 6> = Action.Action<
  `action${I}`,
  Action.Any["input"],
  Action.Any["success"],
  ReadonlyArray<OwnErrors<I>[K][number] | typeof Throttled>,
  true,
  typeof Caller
>;

/** Protected actions `0` to `N - 1`, of `K` errors of their own each. */
export type Numbering<
  N extends number,
  K extends 3 | 6,
  Done extends ReadonlyArray<Action.Any> = [],
> = Done["length"] extends N
  ? Done
  : Numbering<N, K, readonly [...Done, Numbered<Done["length"], K>]>;

/** A handler for each of the actions `L`. */
export type NumberedHandlers<L extends ReadonlyArray<Action.Any>> = {
  readonly [A in L[number] as A["name"]]: () => Effect.Effect<void>;
};
