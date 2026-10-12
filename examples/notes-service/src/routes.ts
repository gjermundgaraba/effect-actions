import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { OpenApi } from "effect/http-api";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Http } from "./Api.js";
import { identity } from "./identity/handlers.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { notes } from "./notes/handlers.js";
import { status } from "./status/handlers.js";

// Every domain's implementation, once. Each surface below takes the same list.
const implementations = [status, notes, identity];

// JSON routes at `/api/<action>`, the binding's. A protected route authenticates before it
// reads its body; `getStatus` answers anyone.
const api = ActionHttp.layer(Http, implementations);

// The same actions as MCP tools at `/mcp`. Listing the tools and calling `getStatus` need no
// token, because `getStatus` is public: an endpoint of protected tools alone asks a token for
// the listing too. Any other call answers 401 with where to sign in, and so does a client of
// an MCP revision with sessions when it opens one, since a session may call any tool.
const mcp = ActionMcp.layerHttp(implementations, {
  name: "notes-service",
  version: "1.0.0",
  instructions: "Notes belong to the signed-in user. Read a note before updating it.",
  authentication: Login,
});

// The host's own routes sit beside the actions' on the same router.
const health = HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"));

const openApi = HttpRouter.add(
  "GET",
  "/api/openapi.json",
  HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)),
);

// What the host serves. It still requires `NoteStore`: the entrypoint chooses which one, and a
// test chooses its own.
export const routes = Layer.mergeAll(api, mcp, health, openApi).pipe(Layer.provide(authenticate));
