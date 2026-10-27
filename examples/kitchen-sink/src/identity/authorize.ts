import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { CurrentMember, scopes } from "./Identity.js";

// The members' rule, read from each contract: a read needs the read scope, anything else the
// write scope. The implementations of issues and attachments state it, so every surface serving
// them runs it before the handler: HTTP, MCP, RPC, stdio, the assistant's tools and a test alike.
// For a bearer token, naming the missing scope turns the 403 into the challenge an OAuth client
// re-authorizes on.
export const authorize = Effect.fn("authorize")(function* (
  contract: Action.Any | Event.Any
) {
  // A subscription to an event reads, as a `readOnly` action does.
  const scope =
    Event.isEvent(contract) || contract.readOnly ? scopes.read : scopes.write;

  const member = yield* CurrentMember;

  if (!member.scopes.includes(scope)) {
    return yield* new Action.Forbidden({
      message: `Requires ${scope}.`,
      scopes: [scope],
    });
  }
});
