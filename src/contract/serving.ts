import type * as Action from "./Action.js";
import { Anyone, assertAuthentication } from "./caller.js";
import type { Proving } from "./caller.js";
import type * as Event from "./Event.js";
import { eventsOf, feedBuilders, selectEvents } from "./feed.js";
import type { AnyEventImplementation } from "./feed.js";
import {
  assertHeld,
  Implementation,
  markingOthers,
  notHeld,
  provideBuilders,
  select,
  servedBy,
  toList,
} from "./implementation.js";
import type { AnyImplementation, Served } from "./implementation.js";
import { selection } from "./listed.js";
import { assertDistinct, assertOnce, heldOnce } from "./names.js";

export const selectFrom = (
  served: Served,
  actions: ReadonlyArray<Action.Any | Event.Any> | undefined
) => {
  const listed = selection(actions);

  return {
    apps: select(toList(served), listed.actions),
    events: selectEvents(eventsOf(served), listed.events),
  };
};

const eventsServedBy = (
  what: string,
  bound: readonly Event.Any[],
  served: Served,
  listed: readonly Event.Any[] | undefined
): readonly AnyEventImplementation[] => {
  const apps = eventsOf(served);

  if (listed !== undefined) {
    assertHeld(notHeld.byBinding, listed, bound);
  }

  const unbound = apps.filter(
    (app) => !app.events.some((event) => bound.includes(event))
  );

  if (
    listed === undefined &&
    unbound.length > 0 &&
    unbound.length === apps.length
  ) {
    const names = new Set(bound.map(({ name }) => name));

    throw new Error(
      `No event of these implementations is in this ${what}: ${markingOthers(
        unbound.flatMap((app) => app.events),
        names
      )} (pass an implementation of a bound event, or bind one of these)`
    );
  }

  const held = new Set(apps.flatMap((app) => app.events));

  const selected = selectEvents(
    apps,
    listed ?? bound.filter((event) => held.has(event))
  );

  assertOnce(
    "served event",
    selected.flatMap((app) => app.events),
    heldOnce
  );

  return selected;
};

export const servingOf = <D extends Proving>(
  what: string,
  binding: {
    readonly actions: readonly Action.Any[];
    readonly events: readonly Event.Any[];
    readonly authentication?: D | undefined;
  },
  served: Served,
  options: {
    readonly actions?: ReadonlyArray<Action.Any | Event.Any> | undefined;
    readonly middleware?: ReadonlyArray<{ readonly key: string }> | undefined;
  }
) => {
  const listed = selection(options.actions);
  const apps = servedBy(what, binding.actions, toList(served), listed.actions);

  const actions = apps.flatMap((app) => app.actions);
  const events = eventsServedBy(what, binding.events, served, listed.events);
  const eventTypes = events.flatMap((app) => app.events);

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
    authentication: [...actions, ...eventTypes].some(
      (contract) => contract.caller !== Anyone
    )
      ? binding.authentication
      : undefined,
  };
};

export const provideServed = (served: {
  readonly apps: readonly AnyImplementation[];
  readonly events: readonly AnyEventImplementation[];
}) =>
  provideBuilders([
    ...served.apps.map((app) => Implementation.layerOf(app)),
    ...feedBuilders(served.events),
  ]);
