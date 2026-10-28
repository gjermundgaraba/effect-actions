import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { Greet } from "./Greeting.js";

export const greeting = Action.implement(Greet, ({ name }) =>
  Effect.succeed(`Hello, ${name}!`)
);
