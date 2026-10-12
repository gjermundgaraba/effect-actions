import { Effect, Exit, Result } from "effect";

export const defectOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => Result.getOrUndefined(Exit.findDefect(exit)));
