import { Layer } from "effect";
import * as ActionMcp from "../src/ActionMcp.js";
import { double, listChanges, status, userActions } from "./handlers.js";

const allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];

// An MCP endpoint is one route, so it authenticates as a whole: a public tool gets an
// endpoint of its own.
const publicMcp = ActionMcp.layerHttp(status, {
  name: "effect-actions-public",
  version: "0.0.0",
  path: "/mcp/public",
  allowedOrigins,
});

// A list of implementations serves all of their actions. `path` defaults to `/mcp`.
const mcp = ActionMcp.layerHttp([userActions, double, listChanges], {
  name: "effect-actions",
  version: "0.0.0",
  allowedOrigins,
});

export const layer = Layer.mergeAll(publicMcp, mcp);
