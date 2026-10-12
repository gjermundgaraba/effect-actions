import { Layer } from "effect";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { authenticate } from "./authentication.js";
import { Login } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

const allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];

// One URL: discovery and `status` answer anyone; a protected tool's call authenticates
// before its arguments are decoded, with the 401 an MCP client signs in on.
export const layer = ActionMcp.layerHttp([status, userActions, double], {
  name: "effect-actions",
  version: "0.0.0",
  allowedOrigins,
  authentication: Login,
}).pipe(Layer.provide(authenticate));
