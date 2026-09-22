import type * as Action from "../Action.js";
import type { HttpApiError } from "effect/unstable/httpapi";

/** One side of a schema-error policy: the error it answers with, and how to make it. */
export interface SchemaErrorAnswer<E extends Action.Codec> {
  /** A declared error schema; its `httpApiStatus` is the HTTP status of the answer. */
  readonly schema: E;
  readonly make: (failure: HttpApiError.HttpApiSchemaError) => NoInfer<E["Type"]>;
}

/**
 * Pure HTTP policy for native schema failures, split by whose fault they are. The
 * library owns the split, so every group draws it the same way.
 */
export interface SchemaErrorPolicy<
  Invalid extends Action.Codec = Action.Codec,
  Internal extends Action.Codec = Action.Codec,
> {
  /** The request did not decode: its payload, or its params, headers or query. */
  readonly invalid: SchemaErrorAnswer<Invalid>;
  /** The handler's result did not encode: its body or its response headers. */
  readonly internal: SchemaErrorAnswer<Internal>;
}

/** The contract half of a group: what adapters and clients need, without `implement`. */
export interface Actions<
  Name extends string = string,
  A extends ReadonlyArray<Action.Any> = ReadonlyArray<Action.Any>,
  PolicyError extends Action.Codec = Action.Codec,
> {
  readonly name: Name;
  readonly actions: A;
  /** How HTTP answers failed decoding or encoding; native behavior without one. MCP is unaffected. */
  readonly schemaError: SchemaErrorPolicy<PolicyError, PolicyError> | undefined;
}

/** The errors a group's policy may answer with, by lookup rather than a conditional type. */
export type PolicyError<G extends Actions> = NonNullable<
  G["schemaError"]
>[keyof SchemaErrorPolicy]["schema"];

/** Each distinct error a policy may answer with, invalid first. */
export const policyErrors = (policy: SchemaErrorPolicy): ReadonlyArray<Action.Codec> => [
  ...new Set([policy.invalid.schema, policy.internal.schema]),
];

/**
 * `HttpApiBuilder` reports these kinds while encoding the handler's answer, after the
 * handler ran; every other kind (`Payload`, `Params`, `Headers`, `Query`) comes from
 * decoding the request before it.
 */
const responseKinds: ReadonlySet<HttpApiError.HttpApiSchemaError["kind"]> = new Set([
  "Body",
  "ResponseHeaders",
]);

/** The policy's answer to one native failure: `internal` for the response side, else `invalid`. */
export const answerSchemaError = (
  policy: SchemaErrorPolicy,
  failure: HttpApiError.HttpApiSchemaError,
) =>
  responseKinds.has(failure.kind) ? policy.internal.make(failure) : policy.invalid.make(failure);

/**
 * An action's own failures plus the ones its surface answers with, which is what
 * a projection of that action declares. A schema the action already declares is
 * not repeated.
 */
export const projectedErrors = (
  action: Action.Any,
  surface: ReadonlyArray<Action.Codec> | undefined,
): ReadonlyArray<Action.Codec> => [...new Set([...action.errors, ...(surface ?? [])])];

const validName = /^[A-Za-z0-9_-]+$/;

/** Names become path segments, OpenAPI identifiers and client method keys. */
export const assertName = (what: string, name: string): void => {
  if (!validName.test(name) || name === "then") throw new Error(`Invalid ${what}: ${name}`);
};

/**
 * The one item of `items` named `name`, narrowed to that contract. A caller passes
 * a literal name, so a miss is a programming error reported as `Unknown <what>`.
 */
export const selectNamed = <T extends { readonly name: string }, Name extends T["name"]>(
  items: ReadonlyArray<T>,
  name: Name,
  what: string,
): Extract<T, { readonly name: Name }> => {
  const item = items.find(
    (candidate): candidate is Extract<T, { readonly name: Name }> => candidate.name === name,
  );

  if (item === undefined) throw new Error(`Unknown ${what}`);

  return item;
};

/** Each namespace is checked by whoever owns it: a group, the routes, or the MCP tools. */
export const assertDistinct = (what: string, names: ReadonlyArray<string>): void => {
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate ${what}: ${name}`);
    seen.add(name);
  }
};
