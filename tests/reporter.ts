import { Cause, ErrorReporter } from "effect";

/**
 * A reporter recording each report holding an error not marked ignored, as one
 * `ErrorReporter.make` builds would forward it; written out, so a second report of one cause
 * is recorded too.
 */
export const recorder = (into: Array<string>): ErrorReporter.ErrorReporter => ({
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause }) => {
    const errors = cause.reasons.flatMap((reason) =>
      Cause.isFailReason(reason)
        ? [reason.error]
        : Cause.isDieReason(reason)
          ? [reason.defect]
          : [],
    );

    if (!errors.every(ErrorReporter.isIgnored)) into.push(Cause.pretty(cause));
  },
});
