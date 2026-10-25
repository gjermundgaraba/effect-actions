import type * as Action from "./Action.js";
import type * as Event from "./Event.js";
import { Anyone, assertAuthentication, type Proving } from "./caller.js";
import { type AnyEventImplementation, eventsOf, feedBuilders, selectEvents } from "./feed.js";
import {
  type AnyImplementation,
  assertHeld,
  Implementation,
  markingOthers,
  notHeld,
  provideBuilders,
  select,
  type Served,
  servedBy,
  toList,
} from "./implementation.js";
import { selection } from "./listed.js";
import { assertDistinct, assertOnce, heldOnce } from "./names.js";

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
 * and event types `options.actions` lists, or every one of the binding's the implementations
 * hold; `authentication` is the binding's where a served contract is protected.
 */
export const servingOf = <D extends Proving>(
  what: string,
  binding: {
    readonly actions: ReadonlyArray<Action.Any>;
    readonly events: ReadonlyArray<Event.Any>;
    readonly authentication?: D | undefined;
  },
  served: Served,
  options: {
    readonly actions?: ReadonlyArray<Action.Any | Event.Any> | undefined;
    readonly middleware?: ReadonlyArray<{ readonly key: string }> | undefined;
  },
) => {
  const listed = selection(options.actions);
  const apps = servedBy(what, binding.actions, toList(served), listed.actions);

  const actions = apps.flatMap((app) => app.actions);
  const events = eventsServedBy(what, binding.events, served, listed.events);
  const eventTypes = events.flatMap((app) => app.events);

  // Why: A binding spread with another descriptor, `{ ...binding, authentication }`, type-checks,
  // so what `make` checked no longer holds for it.
  assertAuthentication(actions, binding.authentication);
  assertAuthentication(eventTypes, binding.authentication, "event");
  assertDistinct("middleware", options.middleware ?? [], (key) => key.key, {
    fix: "list each middleware once",
  });

  return {
    apps,
    actions,
    events,
    eventTypes,
    authentication: [...actions, ...eventTypes].some((contract) => contract.caller !== Anyone)
      ? binding.authentication
      : undefined,
  };
};

/**
 * Provide the builders of what `servingOf` selects, the action implementations' and the event
 * implementations', to a surface's layer.
 */
export const provideServed = (served: {
  readonly apps: ReadonlyArray<AnyImplementation>;
  readonly events: ReadonlyArray<AnyEventImplementation>;
}) =>
  provideBuilders([
    ...served.apps.map((app) => Implementation.layerOf(app)),
    ...feedBuilders(served.events),
  ]);

/**
 * The event implementations among `served` a binding of `bound` serves, each holding the served
 * event types alone: those `listed` lists, or else every bound one, refusing implementations none
 * of whose event types it binds, as `servedBy` refuses such action implementations.
 */
const eventsServedBy = (
  what: string,
  bound: ReadonlyArray<Event.Any>,
  served: Served,
  listed: ReadonlyArray<Event.Any> | undefined,
): ReadonlyArray<AnyEventImplementation> => {
  const apps = eventsOf(served);

  if (listed !== undefined) assertHeld(notHeld.byBinding, listed, bound);

  const unbound = apps.filter((app) => !app.events.some((event) => bound.includes(event)));

  if (listed === undefined && unbound.length > 0 && unbound.length === apps.length) {
    const names = new Set(bound.map(({ name }) => name));

    throw new Error(
      `No event of these implementations is in this ${what}: ${markingOthers(
        unbound.flatMap((app) => app.events),
        names,
      )} (pass an implementation of a bound event, or bind one of these)`,
    );
  }

  const held = apps.flatMap((app) => app.events);
  const selected = selectEvents(apps, listed ?? bound.filter((event) => held.includes(event)));

  assertOnce(
    "served event",
    selected.flatMap((app) => app.events),
    heldOnce,
  );

  return selected;
};
