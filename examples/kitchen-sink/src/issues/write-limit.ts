import { Duration, Effect } from "effect";
import { RateLimiter } from "effect/persistence";
import { CurrentMember, type Member } from "../identity/Identity.js";
import { RateLimited } from "./Issues.js";

// The write limit: ten writes a minute per member. It is the handlers', not a surface's, so it
// holds wherever they run: HTTP, MCP, RPC, stdio and the assistant's tools all count against
// the one limiter. A builder yields this once and wraps each limited handler in the function
// it gets, which fails with an error those actions' contracts declare; every surface sends it
// as any declared error. The limiter is a service, so its counts are shared wherever it is
// provided: memory.ts provides Effect's own, `RateLimiter.layer` over a store. `consume` counts
// in a fixed window unless given `algorithm: "token-bucket"`: ten writes in each minute, so
// twenty may pass across the boundary between two. A strict limit, ten in any sixty seconds,
// is a service of your own of the same shape, yielded here, never part of the issue store.
export const writeLimit = Effect.gen(function* () {
  const limited = yield* limitedBy;

  return <A, E, R>(write: (member: Member) => Effect.Effect<A, E, R>) =>
    limited("writes", 10, write);
});

// The export limit: two exports a minute per member, on the same limiter under a key of its
// own, so exporting spends no write.
export const exportLimit = Effect.gen(function* () {
  const limited = yield* limitedBy;

  return <A, E, R>(read: (member: Member) => Effect.Effect<A, E, R>) => limited("exports", 2, read);
});

const limitedBy = Effect.gen(function* () {
  const limiter = yield* RateLimiter.RateLimiter;

  return <A, E, R>(name: string, limit: number, run: (member: Member) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const member = yield* CurrentMember;

      yield* limiter
        .consume({
          key: JSON.stringify([name, member.workspace, member.id]),
          limit,
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

      return yield* run(member);
    });
});
