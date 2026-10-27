import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { OpenApi } from "effect/http-api";

import { Http } from "./Api.js";
import { identity } from "./identity/handlers.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { notes } from "./notes/handlers.js";
import { status } from "./status/handlers.js";

// Every domain's implementation, once. Each surface below takes the same list.
const implementations = [status, notes, identity];

// JSON routes at `/api/<action>`, the binding's; `getStatus` answers anyone.
const api = ActionHttp.layer(Http, implementations);

// The host's own routes sit beside the actions' on the same router.
const health = HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"));

// Served to anyone, which is a choice: it tells a signed-out caller every action's name and
// shape. To keep them, leave the route out, or provide `Authentication.protect(Login).layer`
// to it.
const openApi = HttpRouter.add(
  "GET",
  "/api/openapi.json",
  HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api))
);

// What the host serves: the JSON routes, the same actions as MCP tools at `/mcp`, and the host's
// own routes. The MCP endpoint serves the public `getStatus` beside the protected tools, so a
// signed-out 2026-07-28 client may list the tools and call `getStatus`; what else needs a token
// is on `ActionMcp.LayerHttpOptions.authentication`. It still requires `NoteStore`: the
// entrypoint chooses which one, and a test chooses its own. The entrypoint also chooses how the
// MCP endpoint runs: one server for every request, or one per request.
const serving = (requestScoped: boolean) =>
  Layer.mergeAll(
    api,
    ActionMcp.layerHttp(implementations, {
      name: "notes-service",
      version: "1.0.0",
      instructions:
        "Notes belong to the signed-in user. Read a note before updating it.",
      authentication: Login,
      requestScoped,
    }),
    health,
    openApi
  ).pipe(Layer.provide(authenticate));

export const routes = serving(false);

export const requestScopedRoutes = serving(true);
