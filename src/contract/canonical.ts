import { Predicate } from "effect";
import type * as Action from "./Action.js";

type ErasedValue = Action.Any["input"]["Type"];

/**
 * `value`, an encoded input, as JSON written one way whatever the order of its objects' keys:
 * what makes two inputs one subscription's key.
 */
export const canonical = (value: ErasedValue): string =>
  JSON.stringify(value, (_key, nested: ErasedValue) =>
    Predicate.isObject(nested) && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).toSorted(([a], [b]) => (a < b ? -1 : 1)))
      : nested,
  );
