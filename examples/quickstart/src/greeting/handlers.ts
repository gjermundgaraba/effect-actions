import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Greet } from "./Greeting.js";

// The implementation: the contract bound to its handler. Every surface takes this one value.
export const greeting = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));
