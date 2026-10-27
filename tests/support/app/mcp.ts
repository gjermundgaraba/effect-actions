import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Layer } from "effect";

import { authenticate } from "./authentication.js";
import { Login } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

const allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];

export const endpoint = ActionMcp.layerHttp([status, userActions, double], {
  name: "effect-actions",
  version: "0.0.0",
  allowedOrigins,
  authentication: Login,
});

export const layer = endpoint.pipe(Layer.provide(authenticate));
