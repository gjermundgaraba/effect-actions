// What the measured fixtures cost before `implement` reads their actions and handlers, which
// `tests/type-budget.test.ts` subtracts: the same imports, the list and the handlers' type.
import { Effect } from "effect";
import * as Action from "../../src/Action.js";
import type { NumberedHandlers, Numbering } from "../numbered.js";

type Listed = Numbering<400, 3>;

export const baseline = (actions: Listed, handlers: NumberedHandlers<Listed>) =>
  [actions[399], handlers.action399, Action.allowAll, Effect.void] as const;
