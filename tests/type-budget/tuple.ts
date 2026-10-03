// One `implement` of 400 actions listed as a tuple, each declaring three errors of its own and
// the limit, behind a hook failing with the limit: measured by `tests/type-budget.test.ts`.
import { Effect } from "effect";
import * as Action from "../../src/Action.js";
import { type NumberedHandlers, type Numbering, Throttled } from "../numbered.js";

type Listed = Numbering<400, 3>;

export const tuple = (actions: Listed, handlers: NumberedHandlers<Listed>) =>
  Action.implement(actions, handlers, () => Effect.fail(new Throttled()));
