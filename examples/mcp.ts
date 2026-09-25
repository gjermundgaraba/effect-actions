import { Layer } from "effect";
import * as ActionMcp from "../src/ActionMcp.js";
import { authentication } from "./authentication.js";
import { authorize } from "./authorization.js";
import { double, listChanges, status, userActions } from "./handlers.js";

const allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];

// An MCP endpoint is one route, so its middleware, authentication included, covers all
// of its tools. Tools that need no credentials get their own endpoint, which compiles
// because this implementation requires nothing per request.
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
  // The same hook the HTTP layer binds; `Forbidden` is declared on each tool, so a
  // refusal is an ordinary tool failure rather than a transport error.
  before: authorize,
}).pipe(Layer.provide(authentication.layer));

export const layer = Layer.mergeAll(publicMcp, mcp);
