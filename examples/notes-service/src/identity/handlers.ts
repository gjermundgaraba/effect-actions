import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { authorize } from "./authorize.js";
import { CurrentUser, WhoAmI } from "./Identity.js";

export const identity = Action.implement(
  WhoAmI,
  () => Effect.map(CurrentUser, ({ id, scopes }) => ({ id, scopes })),
  { authorize }
);
