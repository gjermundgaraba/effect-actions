import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { discovery } from "./authentication.js";
import { layer as http } from "./http.js";
import { layer as mcp } from "./mcp.js";
import { Users } from "./users.js";

const requestPolicy = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request.modify({ url: request.originalUrl }));

    if (Option.isNone(url) || !["localhost", "127.0.0.1"].includes(url.value.hostname)) {
      return HttpServerResponse.text("Host not allowed", { status: 403 });
    }

    const origin = request.headers.origin;

    if (origin !== undefined && origin !== url.value.origin) {
      return HttpServerResponse.text("Origin not allowed", { status: 403 });
    }

    return yield* httpEffect;
  }),
);

// Every surface of one host. Each builder runs once, however many of these layers
// serve its implementation.
export const layer = Layer.mergeAll(http, mcp, discovery.layer).pipe(
  Layer.provide(requestPolicy.layer),
  Layer.provide(Users.layerMemory),
);
