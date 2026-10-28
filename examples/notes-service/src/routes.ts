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

const implementations = [status, notes, identity];

const api = ActionHttp.layer(Http, implementations);

const health = HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok"));

const openApi = HttpRouter.add(
  "GET",
  "/api/openapi.json",
  HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api))
);

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
