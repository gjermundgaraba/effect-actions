import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { Operator } from "./Admin.js";
import { Grants } from "./grants.js";
import type { Grant } from "./grants.js";

export const authorize = Effect.gen(function* () {
  const grants = yield* Grants;

  return (action: Action.Any) =>
    Effect.gen(function* () {
      const operator = yield* Operator;

      if (operator.trusted) {
        return;
      }

      const grant: Grant = action.readOnly
        ? "workspaces:read"
        : "workspaces:suspend";

      if (!(yield* grants.of(operator.id)).includes(grant)) {
        return yield* new Action.Forbidden({
          message: `Requires the ${grant} grant.`,
        });
      }
    });
});
