import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Config, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { serverInfo } from "./instructions.js";
import { printers } from "./printers/handlers.js";

export const routes = Layer.unwrap(
  Effect.gen(function* () {
    const allowedOrigins = yield* Config.Array(
      Schema.String,
      "ALLOWED_ORIGINS"
    ).pipe(Config.withDefault([]));

    const cors =
      allowedOrigins.length === 0
        ? Layer.empty
        : HttpRouter.cors({
            allowedOrigins,
            allowedMethods: ["POST", "DELETE"],
            allowedHeaders: [
              "Content-Type",
              "MCP-Protocol-Version",
              "MCP-Method",
              "MCP-Name",
              "Mcp-Session-Id",
            ],
            exposedHeaders: ["MCP-Protocol-Version", "Mcp-Session-Id"],
          });

    return Layer.mergeAll(
      ActionMcp.layerHttp(printers, { ...serverInfo, allowedOrigins }),
      HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"))
    ).pipe(Layer.provide(cors));
  })
);
