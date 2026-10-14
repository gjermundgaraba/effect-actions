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
        `Protected action '${action.name}' requires its matching authentication descriptor`,
      );
    }
  }
};
