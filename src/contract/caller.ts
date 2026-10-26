import { Context, Effect } from "effect";
import type * as Action from "./Action.js";
import type { Codec } from "./codec.js";

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

/** What declares a caller: an action or an event. */
export type Called = Pick<Action.Any, "name" | "caller">;

/** What names one caller of a surface: its authentication's `principal`, where it has one. */
export interface Keyed {
  principal?(identity: Action.Any["input"]["Type"]): string;
  readonly schema?: Codec | undefined;
}

/** A surface's authentication that names each caller: its `principal` given. */
export interface Named extends Keyed {
  principal(identity: Action.Any["input"]["Type"]): string;
}

/**
 * The authentication of the surface the running call came through, which names its caller where
 * it has a `principal`: none in process, as `Action.client` calls.
 */
export const CallerKeyed = Context.Reference<Keyed | undefined>("effect-actions/CallerKeyed", {
  defaultValue: () => undefined,
});

/** Whether `keyed` names each caller, its `principal` given. */
export const isNamed = (keyed: Keyed | undefined): keyed is Named => keyed?.principal !== undefined;

/**
 * The principal of the caller of `called`, as `keyed` names it: a poll's subscriber, for its
 * `subscription` hook, and whose idempotency keys a call's are. None where `called` is public or
 * `keyed` has no `principal`: every caller is then one.
 */
export const principalOf = (
  called: Pick<Called, "caller">,
  keyed: Keyed | undefined,
): Effect.Effect<string | undefined, never, unknown> =>
  keyed?.principal === undefined || called.caller === Anyone
    ? Effect.succeed(undefined)
    : Effect.map(Effect.service(called.caller), (identity) => keyed.principal?.(identity));

export const assertAuthentication = (
  contracts: ReadonlyArray<Called>,
  authentication: Proving | undefined,
  noun: "action" | "event" = "action",
): void => {
  for (const contract of contracts) {
    if (
      contract.caller !== Anyone &&
      (authentication === undefined || contract.caller.key !== authentication.identity.key)
    ) {
      throw new Error(
        `Protected ${noun} '${contract.name}' requires its matching authentication descriptor (give it the authentication whose identity the ${noun}'s caller names)`,
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
