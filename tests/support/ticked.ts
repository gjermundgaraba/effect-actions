import { Schema } from "effect";

import * as Event from "../../src/contract/Event.js";
import { CurrentActor } from "./app/authorization.js";

export const Ticked = Event.make("ticked", {
  description: "A room ticked.",
  input: { room: Schema.String },
  payload: { at: Schema.Int },
  caller: CurrentActor,
});
