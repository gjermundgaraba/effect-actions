import type { Layer } from "effect";

import type * as Action from "./Action.js";
import { Anyone, assertAuthentication } from "./caller.js";
import type { Proving } from "./caller.js";
import type * as Event from "./Event.js";
import { EventImplementation, eventsOf, selectEvents } from "./feed.js";
import type { AnyEventImplementation } from "./feed.js";
import {
  assertHeld,
  Implementation,
  markingOthers,
  notHeld,
  provideBuilders,
  select,
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

const servedBy = <App, C extends Pick<Action.Any, "name">>(
  noun: "action" | "event",
  what: string,
  bound: readonly C[],
  apps: readonly App[],
  listed: readonly C[] | undefined,
  holds: (app: App) => readonly C[],
  selected: (apps: readonly App[], listed: readonly C[]) => readonly App[]
): readonly App[] => {
  if (listed !== undefined) {
    assertHeld(notHeld.byBinding, listed, bound);
  }

  const held = apps.flatMap(holds);

  if (
    listed === undefined &&
    apps.length > 0 &&
    !held.some((contract) => bound.includes(contract))
  ) {
    const names = new Set(bound.map(({ name }) => name));

    throw new Error(
      `No ${noun} of these implementations is in this ${what}: ${markingOthers(held, names) || "none"} (pass an implementation of a bound ${noun}, or bind one of these)`
    );
  }

  const served = selected(
    apps,
    listed ?? bound.filter((contract) => held.includes(contract))
  );

  assertOnce(`served ${noun}`, served.flatMap(holds), heldOnce);

  return served;
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

  const apps = servedBy(
    "action",
    what,
    binding.actions,
    toList(served),
    listed.actions,
    (app) => app.actions,
    select
  );

  const actions = apps.flatMap((app) => app.actions);

  const events = servedBy(
    "event",
    what,
    binding.events,
    eventsOf(served),
    listed.events,
    (app) => app.events,
    selectEvents
  );

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

interface ServedImplementations {
  readonly apps: readonly AnyImplementation[];
  readonly events: readonly AnyEventImplementation[];
}

export const buildersOf = ({
  apps,
  events,
}: ServedImplementations): ReadonlyArray<
  Layer.Layer<never, unknown, unknown>
> => [
  ...apps.map((app) => Implementation.layerOf(app)),
  ...events.map((app) => EventImplementation.layerOf(app)),
];

export const provideServed = (served: ServedImplementations) =>
  provideBuilders(buildersOf(served));
