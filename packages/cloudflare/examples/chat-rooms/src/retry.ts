import { Cause, Clock, Effect } from "effect";

const minute = 60 * 1000;

const longest = 60 * minute;

const sharedByItsMinute = (at: number) => Math.ceil(at / minute) * minute;

export const retryLater =
  (task: string, attempt: number, retry: (at: number) => Effect.Effect<void>) =>
  <E>(work: Effect.Effect<void, E>): Effect.Effect<void> =>
    Effect.catchCause(work, (cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const delay = Math.min(minute * 2 ** attempt, longest);

      return Effect.logWarning(
        `${task} failed, and is tried again in ${delay / minute} minutes`,
        cause
      ).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.flatMap((now) => retry(sharedByItsMinute(now + delay))),
        Effect.catchCause((scheduling) =>
          Effect.logError(
            `${task} failed, and so did scheduling it again`,
            scheduling
          )
        )
      );
    });
