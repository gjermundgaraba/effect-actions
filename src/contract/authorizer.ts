import { Effect, Predicate } from "effect";
import type { Refusal } from "./errors.js";
import { type ErasedAuthorize, memoized } from "./implementation.js";

// Why: An index TypeScript cannot read until `T` is known, so an implementation written inside a
// surface's arguments infers nothing from what that surface accepts. Rejected: `NoInfer<T>`, which
// stays in a layer's requirements, where providing a union's members in two `Layer.provide` calls
// leaves it owed; this reads as `T` itself once inferred.
/** `T`, read only once it is inferred: an implementation's build channels. */
export type Deferred<T> = [T][T extends unknown ? 0 : never];

// Why: The rule written out, not `Authorize`, since TypeScript would infer `RA` from only one
// branch of a conditional authorizer whose other branch is typed `Authorize`, such as
// `enabled ? authorize : Action.allowAll`, and an alias whose `RA` is not yet inferred gives a
// rule written inside a builder nothing to infer from.
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
  readonly singular: "action";
  readonly module: "Action";
}

const assertRule =
  ({ module }: Holding) =>
  <C>(rule: ErasedAuthorize<C>): ErasedAuthorize<C> => {
    if (!Predicate.isFunction(rule)) {
      throw new Error(
        `Missing authorize: not a function (pass your rule, ${module}.allowAll, or an Effect returning one)`,
      );
    }

    return rule;
  };

/**
 * The memoized authorizer of an implementation: the `authorize` given where it holds a protected
 * contract, which then requires one, and a rule allowing every call where it holds none, which
 * then takes none.
 */
export const authorizerOf = <C>(
  holding: Holding,
  holdsProtected: boolean,
  authorize: ErasedAuthorizer<C> | undefined,
) => {
  const { singular, module } = holding;

  if (holdsProtected && authorize === undefined) {
    throw new Error(`Protected ${singular}s require authorize, or ${module}.allowAll`);
  }

  if (!holdsProtected && authorize !== undefined) {
    throw new Error(
      `A public-only target takes no authorize (remove it, or list a protected ${singular})`,
    );
  }

  const given: ErasedAuthorizer<C> = authorize ?? (() => Effect.void);
  const checked = assertRule(holding);

  return memoized(
    Effect.isEffect(given) ? Effect.map(given, checked) : Effect.succeed(checked(given)),
  );
};
