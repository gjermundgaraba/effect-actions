import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiSwagger, OpenApi } from "effect/http-api";
import * as ActionHttp from "../src/ActionHttp.js";
import { authenticate } from "./authentication.js";
import { Http } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

// One layer: each protected route authenticates before decoding; `status` stays public.
const routes = ActionHttp.layer(Http, [status, userActions, double]).pipe(
  Layer.provide(authenticate),
);

const documentation = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/api/openapi.json",
    HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Http.api)),
  ),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
);

export const layer = Layer.mergeAll(routes, documentation);
