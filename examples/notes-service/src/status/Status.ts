import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

// Public: `caller: Action.Anyone`. It answers before anyone has signed in, on every surface.
export const GetStatus = Action.make("getStatus", {
  description: "Report whether the service is up and how many notes it holds.",
  success: { service: Schema.String, notes: Schema.Finite },
  readOnly: true,
  caller: Action.Anyone,
});
