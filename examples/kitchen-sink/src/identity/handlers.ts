import * as Action from "@gjermundgaraba/effect-actions/Action";

import { CurrentMember, WhoAmI } from "./Identity.js";

export const identity = Action.implement(WhoAmI, () => CurrentMember, {
  authorize: Action.allowAll,
});
