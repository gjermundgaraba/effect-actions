import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { CurrentMember, scopes } from "./Identity.js";

export const authorize = Effect.fn("authorize")(function* (
  contract: Action.Any | Event.Any
) {
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
