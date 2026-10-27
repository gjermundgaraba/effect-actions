import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { allowedOrigins, publicUrl } from "./config.js";

const loopback = ["localhost", "127.0.0.1"];

// Which Host and Origin a request may carry: not the library's concern, but every request of
// both ports passes it first. A Host that is neither loopback nor the public URL's is refused,
// against DNS rebinding. The web app signs in with a cookie, which a browser attaches to
// any page's request, so a foreign Origin must be refused before authentication reads it.
// That is why this is global router middleware (`global: true`): it runs before routing, so
// before every route's authentication. As a layer's own `middleware` it would run inside the
// authentication, too late.
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

        // The request's own origin is that of a page served from this port directly. Behind a
        // proxy ending TLS it is an `http:` one from Effect 4.0.6, whose `originalUrl` takes the
        // scheme of the connection, whatever `X-Forwarded-Proto` says, so the public URL's
        // origin is among `origins`.
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

// CORS for the one cross-origin caller, a browser MCP client. `HttpRouter.cors` is global to
// the router too: it answers the preflight before any route's authentication, and adds its
// headers to refusals as well. An MCP endpoint's `allowedOrigins` is no CORS: it only refuses
// origins. The headers are those an MCP client sends and must be able to read. A client of an
// MCP revision with sessions sends its session's id on each request, reads it from the answer
// that opened the session, and ends the session with a `DELETE`.
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
