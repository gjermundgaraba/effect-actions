import { Effect, Layer } from "effect";
import { McpProtocol } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import * as ActionMcp from "../src/ActionMcp.js";
import { Actions } from "./quickstart.js";

const allowedOrigins = ["https://ui.example.com"];

const app = Actions.implement({ greet: ({ name }) => Effect.succeed(`Hello, ${name}!`) });

const mcp = ActionMcp.layerHttp([app], {
  name: "greetings",
  version: "1.0.0",
  path: "/mcp",
  protocols: [McpProtocol.v2026_07_28],
  allowedOrigins,
});

// Global router CORS handles preflight outside route-level authentication.
// This example is public; protected endpoints still need authentication and a hook.
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
