import { Effect, Schedule } from "effect";
import type { Duration } from "effect";

export const eventually =
  <A>(done: (value: A) => boolean, within: Duration.Input = "10 seconds") =>
  <E, R>(check: Effect.Effect<A, E, R>) =>
    check.pipe(
      Effect.repeat({ until: done, schedule: Schedule.spaced("50 millis") }),
      Effect.timeout(within)
    );
