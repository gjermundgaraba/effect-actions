import { Cause, ErrorReporter } from "effect";

export const recorder = (into: string[]): ErrorReporter.ErrorReporter => ({
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause }) => {
    const errors = cause.reasons.flatMap((reason) => {
      if (Cause.isFailReason(reason)) {
        return [reason.error];
      }

      return Cause.isDieReason(reason) ? [reason.defect] : [];
    });

    if (!errors.every(ErrorReporter.isIgnored)) {
      into.push(Cause.pretty(cause));
    }
  },
});
