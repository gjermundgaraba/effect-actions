import type * as Action from "./Action.js";
import { Anyone, assertAuthentication, type Proving } from "./caller.js";
import { type Served, servedBy, toList } from "./implementation.js";
import { assertDistinct } from "./names.js";

/**
 * What `ActionHttp.layer` and `ActionRpc.layer` serve, with the checks they share: the actions
 * `options.actions` lists, or every one of the binding's the implementations hold;
 * `authentication` is the binding's where a served action is protected.
 */
export const servingOf = <D extends Proving>(
  what: string,
  binding: {
    readonly actions: ReadonlyArray<Action.Any>;
    readonly authentication?: D | undefined;
  },
  served: Served,
  options: {
    readonly actions?: ReadonlyArray<Action.Any> | undefined;
    readonly middleware?: ReadonlyArray<{ readonly key: string }> | undefined;
  },
) => {
  const apps = servedBy(what, binding.actions, toList(served), options.actions);
  const actions = apps.flatMap((app) => app.actions);

  // Why: A binding spread with another descriptor, `{ ...binding, authentication }`, type-checks,
  // so what `make` checked no longer holds for it.
  assertAuthentication(actions, binding.authentication);
  assertDistinct("middleware", options.middleware ?? [], (key) => key.key, {
    fix: "list each middleware once",
  });

  return {
    apps,
    actions,
    authentication: actions.some((action) => action.caller !== Anyone)
      ? binding.authentication
      : undefined,
  };
};
