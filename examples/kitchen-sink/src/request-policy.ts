import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { allowedOrigins, publicUrl } from "./config.js";

const loopback = ["localhost", "127.0.0.1"];

export const requestPolicy = HttpRouter.middleware(
  Effect.gen(function* () {
    const hosts = new Set([...loopback, new URL(yield* publicUrl).hostname]);
    const origins = yield* allowedOrigins;

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        const url = HttpServerRequest.toURL(
          request.modify({ url: request.originalUrl })
        );

        if (Option.isNone(url) || !hosts.has(url.value.hostname)) {
          return HttpServerResponse.text("Host not allowed", { status: 403 });
        }

        const { origin } = request.headers;

        if (
          origin !== undefined &&
          origin !== url.value.origin &&
          !origins.includes(origin)
        ) {
          return HttpServerResponse.text("Origin not allowed", { status: 403 });
        }

        return yield* httpEffect;
      });
  }),
  { global: true }
);

export const cors = Layer.unwrap(
  Effect.map(allowedOrigins, (origins) =>
    HttpRouter.cors({
      allowedOrigins: origins,
      allowedMethods: ["POST", "DELETE"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Workspace",
        "MCP-Protocol-Version",
        "MCP-Method",
        "MCP-Name",
        "Mcp-Session-Id",
      ],
      exposedHeaders: [
        "WWW-Authenticate",
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
      ],
    })
  )
);
