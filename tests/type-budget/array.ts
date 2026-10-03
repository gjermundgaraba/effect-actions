// The tuple fixture's actions as a list whose type fixes no first action, an array of their
// union: measured by `tests/type-budget.test.ts`.
import { Effect } from "effect";
import * as Action from "../../src/Action.js";
import { type NumberedHandlers, type Numbering, Throttled } from "../numbered.js";

type Listed = Numbering<400, 3>;

export const array = (actions: ReadonlyArray<Listed[number]>, handlers: NumberedHandlers<Listed>) =>
  Action.implement(actions, handlers, () => Effect.fail(new Throttled()));
