import { Layer } from "effect";
import { HttpApiSwagger } from "effect/unstable/httpapi";
import * as ActionHttp from "../src/ActionHttp.js";
import { authentication } from "./authentication.js";
import { authorize } from "./authorization.js";
import { Http } from "./binding.js";
import { double, status, userActions } from "./handlers.js";

// One layer per access rule: middleware provided to a layer applies to the routes of
// the actions it serves, and to no others. Status needs no credentials, so it binds no
// hook; every user action is authorized after decoding, before its handler runs.
const routes = Layer.mergeAll(
  ActionHttp.layer(Http, status),
  ActionHttp.layer(Http, [userActions, double], { before: authorize }).pipe(
    Layer.provide(authentication.layer),
  ),
);

// `Http.api` is a native HttpApi, so documents are Effect's own: the OpenAPI JSON at
// `GET /api/openapi.json`, and a Swagger UI reading the same contract.
const documentation = Layer.mergeAll(
  ActionHttp.openApi(Http),
  HttpApiSwagger.layer(Http.api, { path: "/docs" }),
);

export const layer = Layer.mergeAll(routes, documentation);
