import { Layer } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Http } from "./Api.js";
import { greeting } from "./greeting/handlers.js";

// One implementation, two surfaces: a JSON route and an MCP tool at `/mcp`.
export const routes = Layer.mergeAll(
  ActionHttp.layer(Http, greeting),
  ActionMcp.layerHttp(greeting, { name: "greetings", version: "1.0.0" }),
);
