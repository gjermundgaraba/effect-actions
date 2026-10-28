import { Duration, Effect } from "effect";
import { RateLimiter } from "effect/persistence";

import { CurrentMember } from "../identity/Identity.js";
import type { Member } from "../identity/Identity.js";
import { RateLimited } from "./Issues.js";

const limitedBy = Effect.gen(function* () {
  const limiter = yield* RateLimiter.RateLimiter;

  return <A, E, R>(
    name: string,
    limit: number,
    run: (member: Member) => Effect.Effect<A, E, R>
  ) =>
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
              Effect.fail(
                new RateLimited({
                  retryAfterSeconds: Duration.toSeconds(retryAfter),
                })
              ),
            Effect.die
          )
        );

      return yield* run(member);
    });
});

export const writeLimit = Effect.gen(function* () {
  const limited = yield* limitedBy;

  return <A, E, R>(write: (member: Member) => Effect.Effect<A, E, R>) =>
    limited("writes", 10, write);
});

export const exportLimit = Effect.gen(function* () {
  const limited = yield* limitedBy;

  return <A, E, R>(read: (member: Member) => Effect.Effect<A, E, R>) =>
    limited("exports", 2, read);
});
