import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Greet } from "./quickstart.js";

const allowedOrigins = ["https://ui.example.com"];

const actions = Action.implement(Greet, ({ name }) => Effect.succeed(`Hello, ${name}!`));

const mcp = ActionMcp.layerHttp(actions, { name: "greetings", version: "1.0.0", allowedOrigins });

// Global router CORS handles preflight outside route-level authentication.
// This example is public; an endpoint serving protected actions takes their `authentication`.
export const routes = Layer.mergeAll(
  mcp,
  HttpRouter.cors({
    allowedOrigins,
    allowedMethods: ["POST"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "MCP-Protocol-Version",
      "MCP-Method",
      "MCP-Name",
    ],
    exposedHeaders: ["WWW-Authenticate", "MCP-Protocol-Version"],
  }),
);
