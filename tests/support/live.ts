import { Duration, Effect, Schedule } from "effect";

/** Asks `done` every 20 real milliseconds until it holds, dying if it does not within `within`. */
export const eventually = (
  done: () => boolean,
  within: Duration.Input = "10 seconds"
): Effect.Effect<void> =>
  Effect.sync(done).pipe(
    Effect.repeat({
      until: (held) => held,
      schedule: Schedule.spaced("20 millis"),
    }),
    Effect.timeoutOrElse({
      duration: within,
      orElse: () =>
        Effect.die(
          new Error(
            `Never held within ${Duration.format(Duration.fromInputUnsafe(within))}: ${String(done)}`
          )
        ),
    }),
    Effect.asVoid
  );
