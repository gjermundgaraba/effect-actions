import type * as Action from "./Action.js";
import * as Event from "./Event.js";
import { assertOnce } from "./names.js";

/** The members of the list `T` that are `U`: `T` itself where every one is, `[]` where none is. */
export type Only<T extends readonly unknown[], U> = [
  Exclude<T[number], U>,
] extends [never]
  ? Extract<T, readonly U[]>
  : [Extract<T[number], U>] extends [never]
    ? readonly []
    : ReadonlyArray<Extract<T[number], U>>;

export const split = (contracts: ReadonlyArray<Action.Any | Event.Any>) => ({
  actions: contracts.flatMap((contract) =>
    Event.isEvent(contract) ? [] : [contract]
  ),
  events: contracts.filter(Event.isEvent),
});

export const listed = (contracts: ReadonlyArray<Action.Any | Event.Any>) => {
  assertOnce("action or event", contracts);

  return split(contracts);
};

export const selection = (
  contracts: ReadonlyArray<Action.Any | Event.Any> | undefined
): {
  readonly actions: readonly Action.Any[] | undefined;
  readonly events: readonly Event.Any[] | undefined;
} =>
  contracts === undefined
    ? { actions: undefined, events: undefined }
    : split(contracts);
