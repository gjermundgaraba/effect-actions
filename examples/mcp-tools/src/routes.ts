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

    // The Origin check only refuses. A browser also needs CORS: an answer to its preflight, and
    // headers on the endpoint's answers. `HttpRouter.cors` is global to the router and, given
    // no origin, allows every one, so it is added only where an origin is configured. The
    // methods are the endpoint's, the headers those an MCP client sends and must be able to
    // read; an endpoint with authentication adds `Authorization` and exposes `WWW-Authenticate`.
    //
    // Given several origins it names the request's own in `Access-Control-Allow-Origin` when
    // it is listed, and sends no such header otherwise. Given exactly one it compares nothing:
    // every answer names that origin, a preflight from elsewhere included. Both refuse a page
    // elsewhere, whose browser allows a call only where the header names the page's own origin,
    // and the Origin check above has answered its request 403 either way. So a test of one
    // configured origin asserts which origin is named, never that the header is absent.
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
      // No `authentication`: every tool is public, so the endpoint authenticates nothing.
      ActionMcp.layerHttp(printers, { ...serverInfo, allowedOrigins }),
      HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok")),
    ).pipe(Layer.provide(cors));
  }),
);
