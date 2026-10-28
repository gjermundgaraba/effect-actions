import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";

export const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: { name: Schema.String },
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});
