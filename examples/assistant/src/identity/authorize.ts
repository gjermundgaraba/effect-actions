import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { CurrentCaller } from "./Identity.js";
import { Permissions } from "./permissions.js";
import type { Permission } from "./permissions.js";

export const authorize = Effect.gen(function* () {
  const permissions = yield* Permissions;

  return Effect.fn("authorize")(function* (action: Action.Any) {
    const caller = yield* CurrentCaller;

    if (caller.kind === "operator") {
      return;
    }

    const permission: Permission = action.readOnly
      ? "tasks:read"
      : "tasks:write";

    if (!(yield* permissions.granted(caller.id)).includes(permission)) {
      return yield* new Action.Forbidden({
        message: `Requires ${permission}.`,
      });
    }
  });
});
