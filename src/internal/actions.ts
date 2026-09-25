import type { HttpApiError } from "effect/unstable/httpapi";
import type * as Action from "../Action.js";
import type { ErasedValue } from "./implementation.js";

/**
 * How HTTP answers native schema failures, split by whose fault they are: each side
 * returns one of the binding's declared errors, and an omitted side keeps Effect's native
 * empty 400. The library owns the split, so every binding draws it the same way.
 */
export interface SchemaErrorPolicy<E = ErasedValue> {
  /** The request did not decode: its payload, or its params, headers or query. */
  readonly invalid?: (failure: HttpApiError.HttpApiSchemaError) => E;
  /** The handler's result did not encode: its body or its response headers. */
  readonly internal?: (failure: HttpApiError.HttpApiSchemaError) => E;
}

/**
 * `HttpApiBuilder` reports these kinds while encoding the handler's answer, after the
 * handler ran; every other kind (`Payload`, `Params`, `Headers`, `Query`) comes from
 * decoding the request before it.
 */
const responseKinds: ReadonlySet<HttpApiError.HttpApiSchemaError["kind"]> = new Set([
  "Body",
  "ResponseHeaders",
]);

/** The policy's answer to one native failure, or the failure itself for an omitted side. */
export const answerSchemaError = (
  policy: SchemaErrorPolicy,
  failure: HttpApiError.HttpApiSchemaError,
): ErasedValue => {
  const answer = responseKinds.has(failure.kind) ? policy.internal : policy.invalid;

  return answer === undefined ? failure : answer(failure);
};

/**
 * An action's own failures plus the ones its surface answers with, which is what
 * a projection of that action declares. A schema the action already declares is
 * not repeated.
 */
export const projectedErrors = (
  action: Action.Any,
  surface: ReadonlyArray<Action.Codec> | undefined,
): ReadonlyArray<Action.Codec> => [...new Set([...action.errors, ...(surface ?? [])])];

const validName = /^[A-Za-z0-9_-]{1,128}$/;

/** Names become path segments, OpenAPI identifiers and client method keys. */
export const assertName = (what: string, name: string): void => {
  if (!validName.test(name) || name === "then") throw new Error(`Invalid ${what}: ${name}`);
};

/** Names are checked by whoever owns them: an implementation, a binding, a CLI, or the MCP tools. */
export const assertDistinct = (what: string, names: ReadonlyArray<string>): void => {
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate ${what}: ${name}`);
    seen.add(name);
  }
};
