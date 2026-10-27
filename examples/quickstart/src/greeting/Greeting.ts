import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";

// A contract: what the action takes and answers, whether it changes anything, and who may
// call it. It imports no server code, so any client can import it, a browser page included.
export const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: { name: Schema.String },
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});
