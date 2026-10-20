import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Operator } from "./Admin.js";
import { type Grant, Grants } from "./grants.js";

// An authorizer built from a startup service, as a handler builder builds handlers: the
// Effect yields `Grants` once, when the implementation is built, and the function it returns
// reads the operator on every call.
export const authorize = Effect.gen(function* () {
  const grants = yield* Grants;

  return (action: Action.Any) =>
    Effect.gen(function* () {
      const operator = yield* Operator;

      // The one rule admits the console's operator too: no surface has a bypass of its own.
      if (operator.trusted) return;

      const grant: Grant = action.readOnly ? "workspaces:read" : "workspaces:suspend";

      // No `scopes`: a key cannot be re-authorized, so this is a plain 403.
      if (!(yield* grants.of(operator.id)).includes(grant)) {
        return yield* new Action.Forbidden({ message: `Requires the ${grant} grant.` });
      }
    });
});
