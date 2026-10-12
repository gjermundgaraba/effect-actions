import { Duration, Effect } from "effect";
import { RateLimiter } from "effect/persistence";
import { CurrentMember, type Member } from "../identity/Identity.js";
import { RateLimited } from "./Issues.js";

// The write limit: ten writes a minute per member. It is the handlers', not a surface's, so it
// holds wherever they run: HTTP, MCP, RPC, stdio and the assistant's tools all count against
// the one limiter. A builder yields this once and wraps each limited handler in the function
// it gets, which fails with an error those actions' contracts declare; every surface sends it
// as any declared error.
export const writeLimit = Effect.gen(function* () {
  const limiter = yield* RateLimiter.RateLimiter;

  return <A, E, R>(write: (member: Member) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const member = yield* CurrentMember;

      yield* limiter
        .consume({
          key: `writes/${member.workspace}/${member.id}`,
          limit: 10,
          window: "1 minute",
          onExceeded: "fail",
        })
        .pipe(
          Effect.catchReason(
            "RateLimiterError",
            "RateLimitExceeded",
            ({ retryAfter }) =>
              Effect.fail(new RateLimited({ retryAfterSeconds: Duration.toSeconds(retryAfter) })),
            // Any other reason is the limiter's store failing: a defect, not the caller's.
            Effect.die,
          ),
        );

      return yield* write(member);
    });
});
