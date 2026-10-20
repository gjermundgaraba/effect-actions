import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentCaller } from "./Identity.js";
import { type Permission, Permissions } from "./permissions.js";

// The one rule, for a model's tool call and for a command alike. The permission store is a
// startup service, so this Effect gets it; the caller differs per call, so the function it
// returns reads it.
export const authorize = Effect.gen(function* () {
  const permissions = yield* Permissions;

  return Effect.fn("authorize")(function* (action: Action.Any) {
    const caller = yield* CurrentCaller;

    // The operator is trusted, and has no entry in the store. Only a host can name one.
    if (caller.kind === "operator") return;

    const permission: Permission = action.readOnly ? "tasks:read" : "tasks:write";

    if (!(yield* permissions.granted(caller.id)).includes(permission)) {
      return yield* new Action.Forbidden({ message: `Requires ${permission}.` });
    }
  });
});
