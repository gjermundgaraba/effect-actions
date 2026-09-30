import { Effect, Layer } from "effect";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { Greet, Http } from "./quickstart.js";

// Every implementation states who may call it: here, anyone.
const greet = Action.implement(
  Greet,
  ({ name }) => Effect.succeed(`Hello, ${name}!`),
  Action.allowAll,
);

export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greet),
  ActionMcp.layerHttp(greet, { name: "greetings", version: "1.0.0" }),
);
