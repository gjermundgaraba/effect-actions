import type * as Action from "../Action.js";
import type { HttpApiError } from "effect/unstable/httpapi";

/** Pure HTTP policy for native schema decoding and encoding failures. */
export interface SchemaErrorPolicy<Errors extends ReadonlyArray<Action.Codec>> {
  readonly errors: Errors;
  readonly map: (failure: HttpApiError.HttpApiSchemaError) => NoInfer<Errors[number]["Type"]>;
}

/** The contract half of a group: what adapters and clients need, without `implement`. */
export interface Actions<
  Name extends string = string,
  A extends ReadonlyArray<Action.Any> = ReadonlyArray<Action.Any>,
  PolicyErrors extends ReadonlyArray<Action.Codec> = ReadonlyArray<Action.Codec>,
> {
  readonly name: Name;
  readonly actions: A;
  /** How HTTP answers failed decoding or encoding; native behavior without one. MCP is unaffected. */
  readonly schemaError: SchemaErrorPolicy<PolicyErrors> | undefined;
}

/** The errors a group's policy may answer with, by lookup rather than a conditional type. */
export type PolicyError<G extends Actions> = NonNullable<G["schemaError"]>["errors"][number];

/**
 * An action's own failures plus the ones its surface answers with, which is what
 * a projection of that action declares. A schema the action already declares is
 * not repeated.
 */
export const projectedErrors = (
  action: Action.Any,
  surface: ReadonlyArray<Action.Codec> | undefined,
): ReadonlyArray<Action.Codec> => [
  ...action.errors,
  ...(surface ?? []).filter((error) => !action.errors.includes(error)),
];

const validName = /^[A-Za-z0-9_-]+$/;

/** Names become path segments, OpenAPI identifiers and client method keys. */
export const assertName = (what: string, name: string): void => {
  if (!validName.test(name) || name === "then") throw new Error(`Invalid ${what}: ${name}`);
};

/** Each namespace is checked by whoever owns it: a group, the routes, or the MCP tools. */
export const assertDistinct = (what: string, names: ReadonlyArray<string>): void => {
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate ${what}: ${name}`);
    seen.add(name);
  }
};
