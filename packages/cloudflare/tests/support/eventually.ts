import { Effect, Schedule } from "effect";
import type { Duration } from "effect";

/** Runs a check again every 50 milliseconds until `done` holds of its value, timing out after `within`. */
export const eventually =
  <A>(done: (value: A) => boolean, within: Duration.Input = "10 seconds") =>
  <E, R>(check: Effect.Effect<A, E, R>) =>
    check.pipe(
      Effect.repeat({ until: done, schedule: Schedule.spaced("50 millis") }),
      Effect.timeout(within)
    );
