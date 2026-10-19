import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentUser, scopes } from "./Identity.js";

// The one rule, read from each contract: a read needs the read scope, anything else the write
// scope. Naming the missing scope lets an OAuth client ask for it and retry (`Forbidden`):
// `scopes` below goes with `protectedResource` in verifier.ts, copy both or neither.
// This named span measures authorization within the action's span, including a refusal.
export const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const scope = action.readOnly ? scopes.read : scopes.write;
  const user = yield* CurrentUser;

  if (!user.scopes.includes(scope)) {
    return yield* new Action.Forbidden({ message: `Requires ${scope}.`, scopes: [scope] });
  }
});
