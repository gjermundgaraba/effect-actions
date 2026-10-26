import { Effect, Predicate, Schema } from "effect";
import type { Codec } from "./codec.js";
import type { ErasedValue } from "./implementation.js";

/**
 * `value`, an encoded input, as JSON written one way whatever the order of its objects' keys:
 * what makes two inputs one, for a subscription's key and an idempotency key's input alike.
 */
export const canonical = (value: ErasedValue): string =>
  JSON.stringify(value, (_key, nested: ErasedValue) =>
    Predicate.isObject(nested) && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).toSorted(([a], [b]) => (a < b ? -1 : 1)))
      : nested,
  );

/** `input`, encoded to JSON by `schema`, as `canonical` writes it. */
export const canonicalInput = (schema: Codec, input: ErasedValue): Effect.Effect<string> =>
  Effect.map(
    Effect.orDie(Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(input)),
    canonical,
  );
