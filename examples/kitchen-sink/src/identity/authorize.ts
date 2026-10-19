import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember, scopes } from "./Identity.js";

// The members' rule, read from each contract: a read needs the read scope, anything else the
// write scope. The implementations of issues and attachments state it, so every surface serving
// them runs it before the handler: HTTP, MCP, RPC, stdio, the assistant's tools and a test alike.
// For a bearer token, naming the missing scope turns the 403 into the challenge an OAuth client
// re-authorizes on.
export const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const scope = action.readOnly ? scopes.read : scopes.write;
  const member = yield* CurrentMember;

  if (!member.scopes.includes(scope)) {
    return yield* new Action.Forbidden({ message: `Requires ${scope}.`, scopes: [scope] });
  }
});
