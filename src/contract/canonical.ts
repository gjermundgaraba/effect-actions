import { Effect, Predicate, Schema } from "effect";

import type { Codec } from "./codec.js";
import type { ErasedValue } from "./implementation.js";

export const canonical = (value: ErasedValue): string =>
  JSON.stringify(value, (_key, nested: ErasedValue) =>
    Predicate.isObject(nested) && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).toSorted(([a], [b]) => (a < b ? -1 : 1))
        )
      : nested
  );

export const canonicalInput = (
  schema: Codec,
  input: ErasedValue
): Effect.Effect<string> =>
  Effect.map(
    Effect.orDie(Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(input)),
    canonical
  );
