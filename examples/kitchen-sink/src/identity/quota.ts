import { Duration, Effect, Layer } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
import { RateLimiter } from "effect/persistence";
import { RpcMiddleware } from "effect/rpc";
import { CurrentMember, QuotaExceeded } from "./Identity.js";

// The API's request quota: 60 requests a minute per member. It is a surface's own middleware,
// not a handler's check, because it must count before the input is decoded: a request whose
// body does not decode counts too. It runs inside authentication, so it may require the
// caller. HTTP and RPC each have their native middleware; an MCP endpoint takes none.

/** Listed in `ActionHttp.layer`'s `middleware`. It fails only with an error the binding declares. */
export class HttpQuota extends HttpApiMiddleware.Service<HttpQuota, { requires: CurrentMember }>()(
  "tracker/HttpQuota",
  { error: QuotaExceeded },
) {}

/** Listed in `ActionRpc.layer`'s `middleware`: the same quota, counted per message. */
export class RpcQuota extends RpcMiddleware.Service<RpcQuota, { requires: CurrentMember }>()(
  "tracker/RpcQuota",
  { error: QuotaExceeded },
) {}

// What both middleware do before a call. Each middleware's layer builds this for itself, so it
// runs twice; the count is one all the same, because both yield the one `RateLimiter` the
// entrypoint provides and spend under the same key.
const spend = Effect.gen(function* () {
  const limiter = yield* RateLimiter.RateLimiter;

  return Effect.gen(function* () {
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
            Effect.fail(new QuotaExceeded({ retryAfterSeconds: Duration.toSeconds(retryAfter) })),
          // Any other reason is the limiter's store failing: a defect, never the caller's.
          Effect.die,
        ),
      );
  });
});

export const quota = Layer.merge(
  Layer.effect(
    HttpQuota,
    Effect.map(spend, (spent) => (route) => Effect.andThen(spent, route)),
  ),
  Layer.effect(
    RpcQuota,
    Effect.map(spend, (spent) => (rpc) => Effect.andThen(spent, rpc)),
  ),
);
