import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { authorize } from "./authorize.js";
import { CurrentCaller, WhoAmI } from "./Identity.js";

export const identity = Action.implement(
  WhoAmI,
  () => Effect.map(CurrentCaller, ({ id, kind }) => ({ id, kind })),
  { authorize }
);
