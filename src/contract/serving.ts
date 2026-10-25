import type * as Action from "./Action.js";
import type * as Event from "./Event.js";
import { Anyone, assertAuthentication, type Proving } from "./caller.js";
import { eventsOf, selectEvents } from "./feed.js";
import { select, type Served, servedBy, toList } from "./implementation.js";
import { selection } from "./listed.js";
import { assertDistinct } from "./names.js";

/**
 * What a surface without a binding serves of `served`: the actions and event types `actions`
 * lists, each implementation holding those alone, or every one where it lists none.
 */
export const selectFrom = (
  served: Served,
  actions: ReadonlyArray<Action.Any | Event.Any> | undefined,
) => {
  const listed = selection(actions);

  return {
    apps: select(toList(served), listed.actions),
    events: selectEvents(eventsOf(served), listed.events),
  };
};

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
