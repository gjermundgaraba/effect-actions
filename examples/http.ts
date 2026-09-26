import { Layer } from "effect";
import { HttpApiSwagger } from "effect/unstable/httpapi";
import * as ActionHttp from "../src/ActionHttp.js";
import { Http } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

// One layer for every action: each implementation brings its own policy, so `status`
// stays public while the others authenticate and authorize.
const routes = ActionHttp.layer(Http, [status, userActions, double]);

// `Http.api` is a native HttpApi, so documents are Effect's own: the OpenAPI JSON at
// `GET /api/openapi.json`, and a Swagger UI reading the same contract.
const documentation = Layer.mergeAll(
  ActionHttp.openApi(Http),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
);

export const layer = Layer.mergeAll(routes, documentation);
