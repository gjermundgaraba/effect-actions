import { Context, Effect, Function } from "effect";

import type * as Action from "./Action.js";
import type { Codec } from "./codec.js";

/**
 * The caller of a public action, `caller: Action.Anyone`: anyone, signed in or not, and no
 * authorizer runs for it. Registered globally, so two copies of the package agree on it, as they
 * agree on a name.
 */
export const Anyone: unique symbol = Symbol.for(
  "@gjermundgaraba/effect-actions/Anyone"
);

export interface Proving {
  readonly identity: { readonly key: string };
}

export type Called = Pick<Action.Any, "name" | "caller">;

/** What names one caller of a surface: its authentication's `principal`. */
export interface Keyed {
  readonly principal: (identity: Action.Any["input"]["Type"]) => string;
  readonly schema?: Codec | undefined;
}

export const CallerKeyed = Context.Reference<Keyed | undefined>(
  "effect-actions/CallerKeyed",
  {
    defaultValue: Function.constUndefined,
  }
);

/** The caller's principal: none for a public one, or on a surface with no authentication. */
export const principalOf = (
  called: Pick<Called, "caller">,
  keyed: Keyed | undefined
): Effect.Effect<string | undefined, never, unknown> =>
  keyed === undefined || called.caller === Anyone
    ? Effect.undefined
    : Effect.map(Effect.service(called.caller), keyed.principal);

export const assertAuthentication = (
  contracts: readonly Called[],
  authentication: Proving | undefined,
  noun: "action" | "event" = "action"
): void => {
  for (const contract of contracts) {
    if (
      contract.caller !== Anyone &&
      (authentication === undefined ||
        contract.caller.key !== authentication.identity.key)
    ) {
      throw new Error(
        `Protected ${noun} '${contract.name}' requires its matching authentication descriptor (give it the authentication whose identity the ${noun}'s caller names)`
      );
    }
  }
};

export const assertCaller = (caller: Action.Options["caller"]): void => {
  if (caller !== Anyone && !Context.isKey(caller)) {
    throw new Error(
      "Missing caller: declare Action.Anyone or an identity service key"
    );
  }

  if (caller !== Anyone && Context.isReference(caller)) {
    throw new Error(
      "Invalid caller: an identity is a Context.Service, not a Context.Reference"
    );
  }
};
