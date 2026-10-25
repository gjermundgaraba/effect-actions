import type * as Action from "./Action.js";
import * as Event from "./Event.js";
import { assertOnce } from "./names.js";

/** The members of the list `T` that are `U`: `T` itself where every one is, `[]` where none is. */
export type Only<T extends ReadonlyArray<unknown>, U> = [Exclude<T[number], U>] extends [never]
  ? Extract<T, ReadonlyArray<U>>
  : [Extract<T[number], U>] extends [never]
    ? readonly []
    : ReadonlyArray<Extract<T[number], U>>;

/** A list split into its actions and its event types. */
export const split = (contracts: ReadonlyArray<Action.Any | Event.Any>) => ({
  actions: contracts.flatMap((contract) => (Event.isEvent(contract) ? [] : [contract])),
  events: contracts.filter(Event.isEvent),
});

// Why: An action and an event type share a binding's client, one method each by name.
/** A binding's list split into its actions and its event types, each name used once. */
export const listed = (contracts: ReadonlyArray<Action.Any | Event.Any>) => {
  const each = split(contracts);

  assertOnce("action", each.actions);
  assertOnce("action or event", contracts);

  return each;
};

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
