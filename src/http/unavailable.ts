import { Cause, Effect, ErrorReporter, Layer, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";

import { Unavailable } from "../contract/errors.js";

const encode = Schema.encodeUnknownSync(Schema.toCodecJson(Unavailable));

export class RetryAfter extends HttpApiMiddleware.Service<RetryAfter>()(
  "effect-actions/http/RetryAfter"
) {}

export const retryAfter = Layer.succeed(RetryAfter, (route) =>
  Effect.catchIf(route, Schema.is(Unavailable), (error) =>
    Effect.as(
      ErrorReporter.report(Cause.fail(error)),
      HttpServerResponse.jsonUnsafe(encode(error), {
        status: 503,
        headers: { "retry-after": "1" },
      })
    )
  )
);
