import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

// Host and origin checks for a server bound to localhost: not the library's concern, but
// every surface of the host sits behind them.
export const requestPolicy = HttpRouter.middleware((httpEffect) =>
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
