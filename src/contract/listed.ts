import type * as Action from "./Action.js";
import * as Event from "./Event.js";

/** A list split into its actions and its event types. */
export const split = (contracts: ReadonlyArray<Action.Any | Event.Any>) => ({
  actions: contracts.flatMap((contract) => (Event.isEvent(contract) ? [] : [contract])),
  events: contracts.filter(Event.isEvent),
});

/**
 * A surface's `actions` option split into the actions and the event types it lists, both absent
 * where it is: a surface given the option serves exactly what it lists.
 */
export const selection = (
  contracts: ReadonlyArray<Action.Any | Event.Any> | undefined,
): {
  readonly actions: ReadonlyArray<Action.Any> | undefined;
  readonly events: ReadonlyArray<Event.Any> | undefined;
} => (contracts === undefined ? { actions: undefined, events: undefined } : split(contracts));
