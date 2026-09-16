import { Effect, Layer, Schema } from "effect";
import { Action, ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";

const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  mcp: { readOnly: true },
});

export const Actions = ActionGroup.make(Greet);
const app = Actions.implement({
  greet: ({ name }) => Effect.succeed(`Hello, ${name}!`),
});

export const routes = Layer.mergeAll(
  ActionHttp.layer(app, {
    apiPath: "/api/actions",
    openapiPath: "/openapi.json",
  }),
  ActionMcp.layer(app, { name: "greetings", version: "1.0.0", path: "/mcp" }),
);
