// The actions of the large fixtures, as types only: as many as a fixture lists, each declaring
// errors of its own and the limit every one of them declares.
import { type Effect, Schema } from "effect";
import type * as Action from "../src/Action.js";

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

/** Action `I` of the large fixtures: `K` errors of its own, and the limit. */
type Numbered<I extends number, K extends 3 | 6> = Action.Action<
  `action${I}`,
  Action.Any["input"],
  Action.Any["success"],
  readonly [...OwnErrors<I>[K], typeof Throttled],
  "read"
>;

/** Actions `0` to `N - 1`, of `K` errors of their own each. */
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
