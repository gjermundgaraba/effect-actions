import { Config, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { serverInfo } from "./instructions.js";
import { printers } from "./printers/handlers.js";

// The tools at `/mcp` and the host's own route beside them. It is a Layer built from `Config`
// because the origins are known only where the server is deployed.
export const routes = Layer.unwrap(
  Effect.gen(function* () {
    // A browser sends its page's `Origin`, and the endpoint refuses every origin not listed
    // here, so a web page a user happens to visit cannot call the tools. Other MCP clients
    // send none and pass. `ALLOWED_ORIGINS=https://a.example,https://b.example`; none by default.
    const allowedOrigins = yield* Config.Array(Schema.String, "ALLOWED_ORIGINS").pipe(
      Config.withDefault([]),
    );

    return Layer.mergeAll(
      // No `authentication`: every tool is public, so the endpoint authenticates nothing.
      ActionMcp.layerHttp(printers, { ...serverInfo, allowedOrigins }),
      HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok")),
    );
  }),
);
