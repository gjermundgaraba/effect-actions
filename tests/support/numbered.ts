import { Context, type Effect, Schema } from "effect";
import * as Action from "../../src/contract/Action.js";

export class Caller extends Context.Service<Caller, string>()("numbered/Caller") {}

export class Throttled extends Schema.TaggedError<Throttled>()(
  "Throttled",
  {},
  { httpApiStatus: 429 },
) {}

type OwnError<Tag extends string> = Schema.Codec<{ readonly _tag: Tag }>;

type OwnErrors<I extends number> = {
  readonly 3: readonly [OwnError<`${I}a`>, OwnError<`${I}b`>, OwnError<`${I}c`>];
  readonly 6: readonly [
    OwnError<`${I}a`>,
    OwnError<`${I}b`>,
    OwnError<`${I}c`>,
    OwnError<`${I}d`>,
    OwnError<`${I}e`>,
    OwnError<`${I}f`>,
  ];
};

type Numbered<I extends number, K extends 3 | 6> = Action.Action<
  `action${I}`,
  Action.Any["input"],
  Action.Any["success"],
  ReadonlyArray<OwnErrors<I>[K][number] | typeof Throttled>,
  true,
  typeof Caller
>;

export type Numbering<
  N extends number,
  K extends 3 | 6,
  Done extends ReadonlyArray<Action.Any> = [],
> = Done["length"] extends N
  ? Done
  : Numbering<N, K, readonly [...Done, Numbered<Done["length"], K>]>;

export type NumberedHandlers<L extends ReadonlyArray<Action.Any>> = {
  readonly [A in L[number] as A["name"]]: () => Effect.Effect<void>;
};
