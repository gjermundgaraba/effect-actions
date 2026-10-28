import { Effect, Predicate } from "effect";

import type { Refusal } from "./errors.js";
import { memoized } from "./implementation.js";
import type { ErasedAuthorize } from "./implementation.js";

/** `T`, read only once it is inferred: an implementation's build channels. */
export type Deferred<T> = [T][T extends unknown ? 0 : never];

/** What `implement` takes as `authorize` for contracts `C`: the rule, or an Effect building it. */
export type Authorizer<C, RA, EAX, RAX> =
  | ((contract: C) => Effect.Effect<void, Refusal, RA>)
  | Effect.Effect<(contract: C) => Effect.Effect<void, Refusal, RA>, EAX, RAX>;

/** What `implement` takes as `authorize`, erased: the rule, or an Effect building it. */
export type ErasedAuthorizer<C> =
  | ErasedAuthorize<C>
  | Effect.Effect<ErasedAuthorize<C>, unknown, unknown>;

/** How the messages name what an implementation holds. */
export interface Holding {
  readonly singular: "action" | "event";
  readonly module: "Action" | "Event";
}

export const authorizerOf = <C>(
  holding: Holding,
  holdsProtected: boolean,
  authorize: ErasedAuthorizer<C> | undefined
) => {
  const { singular, module } = holding;

  if (holdsProtected && authorize === undefined) {
    throw new Error(
      `Protected ${singular}s require authorize, or ${module}.allowAll`
    );
  }

  if (!holdsProtected && authorize !== undefined) {
    throw new Error(
      `A public-only target takes no authorize (remove it, or list a protected ${singular})`
    );
  }

  const checked = (rule: ErasedAuthorize<C>): ErasedAuthorize<C> => {
    if (!Predicate.isFunction(rule)) {
      throw new Error(
        `Missing authorize: not a function (pass your rule, ${module}.allowAll, or an Effect returning one)`
      );
    }

    return rule;
  };

  const given: ErasedAuthorizer<C> = authorize ?? (() => Effect.void);

  return memoized(
    Effect.isEffect(given)
      ? Effect.map(given, checked)
      : Effect.succeed(checked(given))
  );
};
