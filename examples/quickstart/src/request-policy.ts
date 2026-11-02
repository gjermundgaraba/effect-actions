import * as RequestPolicy from "@gjermundgaraba/effect-actions/RequestPolicy";
import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { routes } from "./routes.js";

export const withRequestPolicy = (publicUrl: URL) => {
  const policy = RequestPolicy.make({ publicUrl });

  const health = HttpRouter.add(
    "GET",
    "/healthz",
    HttpServerResponse.text("ok")
  );

  return Layer.mergeAll(routes, health).pipe(
    Layer.provide(policy.middleware.layer)
  );
};
