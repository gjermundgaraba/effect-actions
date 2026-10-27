import * as Action from "@gjermundgaraba/effect-actions/Action";

import { CurrentMember, WhoAmI } from "./Identity.js";

// `Action.allowAll`: verification is the whole policy here. Any authenticated member may ask
// who they are, whatever their scopes, so there is no rule to state. It must still be said:
// an implementation of a protected action without `authorize` does not compile.
export const identity = Action.implement(WhoAmI, () => CurrentMember, {
  authorize: Action.allowAll,
});
