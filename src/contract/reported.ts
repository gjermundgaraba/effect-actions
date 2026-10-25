import { type Cause, Effect, ErrorReporter } from "effect";

/** Logs `cause` and gives it to the request's `ErrorReporter`s, as a failed call's is. */
export const reported = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.andThen(Effect.logError(cause), ErrorReporter.report(cause));

class InternalError extends Error {
  override readonly [ErrorReporter.ignore] = true;

  constructor() {
    super("Internal server error");
  }
}

/**
 * `cause` `reported`, then a defect that says no more than "Internal server error", reported no
 * further: what a surface sends where it would otherwise encode a defect's details.
 */
export const concealed = (cause: Cause.Cause<unknown>): Effect.Effect<never> =>
  Effect.andThen(reported(cause), Effect.die(new InternalError()));
