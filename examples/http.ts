import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiSwagger, OpenApi } from "effect/http-api";
import * as ActionHttp from "../src/ActionHttp.js";
import { authenticate } from "./authentication.js";
import { Http } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

// One binding, two layers: authentication covers the routes of the layer it is provided
// to, so `status` stays public while the others authenticate. Each layer serves the
// binding's actions its implementations hold, so the public one is given only
// implementations of public actions.
const routes = Layer.mergeAll(
  ActionHttp.layer(Http, status),
  ActionHttp.layer(Http, [userActions, double]).pipe(Layer.provide(authenticate)),
);

// `Http.api` is a native HttpApi, so documents are Effect's own: the OpenAPI JSON at
// `GET /api/openapi.json`, and a Swagger UI reading the same contract, its bearer scheme
// included.
const documentation = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/api/openapi.json",
    HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)),
  ),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
);

export const layer = Layer.mergeAll(routes, documentation);
