import { Cause, ErrorReporter } from "effect";

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
