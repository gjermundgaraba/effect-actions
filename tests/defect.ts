import { Effect, Exit, Result } from "effect";

/**
 * What `effect` dies with, such as building a layer, `Layer.build(layer)`: a defect, not a
 * typed failure, so no tag catches it. `undefined` when it succeeds or fails.
 */
export const defectOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => Result.getOrUndefined(Exit.findDefect(exit)));
