import { Effect, Layer, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";

const Greet = Action.make("greet", {
  description: "Greet someone by name.",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  mcp: { readOnly: true },
});

export const Actions = ActionGroup.make("greetings", Greet);

export const Http = ActionHttp.make({ apiPath: "/api/actions" }, Actions);

const app = Actions.implement({
  greet: ({ name }) => Effect.succeed(`Hello, ${name}!`),
});

export const routes = Layer.mergeAll(
  Http.layer(app),
  Http.layerOpenapi("/openapi.json"),
  ActionMcp.layer({ name: "greetings", version: "1.0.0", path: "/mcp" }, app),
);
