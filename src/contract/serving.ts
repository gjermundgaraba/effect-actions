import type { Layer } from "effect";

import type * as Action from "./Action.js";
import { Anyone, assertAuthentication } from "./caller.js";
import type { Proving } from "./caller.js";
import type * as Event from "./Event.js";
import { EventImplementation, eventKind, eventsOf } from "./feed.js";
import type { AnyEventImplementation } from "./feed.js";
import {
  assertHeld,
  Implementation,
  markingOthers,
  notHeld,
  provideBuilders,
  select,
  toList,
  actionKind,
} from "./implementation.js";
import type {
  AnyImplementation,
  ContractKind,
  Served,
} from "./implementation.js";
import { selection } from "./listed.js";
import { assertDistinct, assertOnce, heldOnce } from "./names.js";

export const selectFrom = (
  served: Served,
  actions: ReadonlyArray<Action.Any | Event.Any> | undefined
) => {
  const listed = selection(actions);

  return {
    apps: select(actionKind, toList(served), listed.actions),
    events: select(eventKind, eventsOf(served), listed.events),
  };
};

const servedBy = <App, C extends Pick<Action.Any, "name">>(
  kind: ContractKind<App, C>,
  bound: readonly C[],
  apps: readonly App[],
  listed: readonly C[] | undefined
): readonly App[] => {
  const { noun, holds } = kind;

  if (listed !== undefined) {
    assertHeld(notHeld.byBinding, listed, bound);
  }

  const held = new Set(apps.flatMap(holds));

  const served = select(
    kind,
    apps,
    listed ?? bound.filter((contract) => held.has(contract))
  );

  assertOnce(`served ${noun}`, served.flatMap(holds), heldOnce);

  return served;
};

const assertBound = <App, C extends Pick<Action.Any, "name">>(
  { noun, holds }: ContractKind<App, C>,
  what: string,
  bound: readonly C[],
  apps: readonly App[],
  served: readonly App[],
  otherServed: readonly unknown[]
): void => {
  if (
    served.length === 0 &&
    apps.length > 0 &&
    (bound.length > 0 || otherServed.length === 0)
  ) {
    const names = new Set(bound.map(({ name }) => name));

    throw new Error(
      `No ${noun} of these implementations is in this ${what}: ${markingOthers(apps.flatMap(holds), names) || "none"} (pass an implementation of a bound ${noun}, or bind one of these)`
    );
  }
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
  const implementations = toList(served);
  const eventImplementations = eventsOf(served);

  const apps = servedBy(
    actionKind,
    binding.actions,
    implementations,
    listed.actions
  );

  const events = servedBy(
    eventKind,
    binding.events,
    eventImplementations,
    listed.events
  );

  if (listed.actions === undefined) {
    assertBound(
      actionKind,
      what,
      binding.actions,
      implementations,
      apps,
      events
    );
  }

  if (listed.events === undefined) {
    assertBound(
      eventKind,
      what,
      binding.events,
      eventImplementations,
      events,
      apps
    );
  }

  const actions = apps.flatMap((app) => app.actions);

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

export const buildersOf = (
  apps: readonly AnyImplementation[],
  events: readonly AnyEventImplementation[] = []
): ReadonlyArray<Layer.Layer<never, unknown, unknown>> => [
  ...apps.map((app) => Implementation.layerOf(app)),
  ...events.map((app) => EventImplementation.layerOf(app)),
];

export const provideServed = (
  apps: readonly AnyImplementation[],
  events: readonly AnyEventImplementation[] = []
) => provideBuilders(buildersOf(apps, events));
