import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentUser, scopes } from "./Identity.js";

// The one rule, read from each contract: a read needs the read scope, anything else the write
// scope. Every implementation of protected actions states it, so HTTP, MCP and stdio all run it
// before the handler. Naming the missing scope lets an OAuth client ask for it and retry: it is
// answered a challenge, which only a server publishing discovery (verifier.ts) can follow up.
// Where tokens are fixed, such as API keys, name no scope: the refusal is then a plain one.
// So `scopes` below goes when `protectedResource` in verifier.ts does: copy both or neither.
export const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const scope = action.readOnly ? scopes.read : scopes.write;
  const user = yield* CurrentUser;

  if (!user.scopes.includes(scope)) {
    return yield* new Action.Forbidden({ message: `Requires ${scope}.`, scopes: [scope] });
  }
});
