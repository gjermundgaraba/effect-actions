import { Duration, Effect, Layer } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
import { RateLimiter } from "effect/persistence";
import { RpcMiddleware } from "effect/rpc";

import { CurrentMember, QuotaExceeded } from "./Identity.js";

export class HttpQuota extends HttpApiMiddleware.Service<
  HttpQuota,
  { requires: CurrentMember }
>()("tracker/HttpQuota", { error: QuotaExceeded }) {}

export class RpcQuota extends RpcMiddleware.Service<
  RpcQuota,
  { requires: CurrentMember }
>()("tracker/RpcQuota", { error: QuotaExceeded }) {}

const spend = Effect.map(RateLimiter.RateLimiter, (limiter) =>
  Effect.gen(function* () {
    const member = yield* CurrentMember;

    yield* limiter
      .consume({
        key: JSON.stringify(["requests", member.workspace, member.id]),
        limit: 60,
        window: "1 minute",
        onExceeded: "fail",
      })
      .pipe(
        Effect.catchReason(
          "RateLimiterError",
          "RateLimitExceeded",
          ({ retryAfter }) =>
            Effect.fail(
              new QuotaExceeded({
                retryAfterSeconds: Duration.toSeconds(retryAfter),
              })
            ),
          Effect.die
        )
      );
  })
);

export const quota = Layer.merge(
  Layer.effect(
    HttpQuota,
    Effect.map(spend, (spent) => (route) => Effect.andThen(spent, route))
  ),
  Layer.effect(
    RpcQuota,
    Effect.map(spend, (spent) => (rpc) => Effect.andThen(spent, rpc))
  )
);
