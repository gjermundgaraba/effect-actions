import { Context } from "effect";
import type * as Action from "./Action.js";

/**
 * The caller of a public action, `caller: Action.Anyone`: anyone, signed in or not, and no
 * authorizer runs for it. Registered globally, so two copies of the package agree on it, as they
 * agree on a name.
 */
export const Anyone: unique symbol = Symbol.for("@gjermundgaraba/effect-actions/Anyone");

/** An authentication descriptor, as the checks read it: the identity it proves. */
export interface Proving {
  readonly identity: { readonly key: string };
}

export const assertAuthentication = (
  actions: ReadonlyArray<Action.Any>,
  authentication: Proving | undefined,
): void => {
  for (const action of actions) {
    if (
      action.caller !== Anyone &&
      (authentication === undefined || action.caller.key !== authentication.identity.key)
    ) {
      throw new Error(
        `Protected action '${action.name}' requires its matching authentication descriptor (give it the authentication whose identity the action's caller names)`,
      );
    }
  }
};

/** Refuses a declared `caller` that is neither `Anyone` nor an identity service. */
export const assertCaller = (caller: Action.Options["caller"]): void => {
  if (caller !== Anyone && !Context.isKey(caller)) {
    throw new Error("Missing caller: declare Action.Anyone or an identity service key");
  }

  if (caller !== Anyone && Context.isReference(caller)) {
    throw new Error("Invalid caller: an identity is a Context.Service, not a Context.Reference");
  }
};
