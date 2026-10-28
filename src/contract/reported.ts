import { Effect, ErrorReporter } from "effect";
import type { Cause } from "effect";

export const reported = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.andThen(Effect.logError(cause), ErrorReporter.report(cause));

class InternalError extends Error {
  override readonly [ErrorReporter.ignore] = true;

  constructor() {
    super("Internal server error");
  }
}

export const concealed = (cause: Cause.Cause<unknown>): Effect.Effect<never> =>
  Effect.andThen(reported(cause), Effect.die(new InternalError()));
