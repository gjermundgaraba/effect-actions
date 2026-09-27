// Its own modules rather than the barrel's namespaces, which esbuild keeps whole in a client.
import { isString } from "effect/Predicate";
import { type AST, isLiteral, isObjects, isUnion, toEncoded } from "effect/SchemaAST";
import type * as Action from "../Action.js";
import { httpErrors } from "./errors.js";

/**
 * An action's own failures plus the ones its surface answers with, which is what
 * a projection of that action declares. A schema the action already declares is
 * not repeated.
 */
export const projectedErrors = (
  action: Action.Any,
  surface: Action.Any["errors"],
): Action.Any["errors"] => [...new Set([...action.errors, ...surface])];

const validName = /^[A-Za-z0-9_-]{1,128}$/;

/** Names become path segments, OpenAPI identifiers and client method keys. */
export const assertName = (what: string, name: string): void => {
  if (!validName.test(name) || name === "then") throw new Error(`Invalid ${what}: ${name}`);
};

/**
 * Names are checked by whoever owns them: an implementation, a binding, a CLI, or the MCP
 * tools. `claimantOf` says who claims a name, so a clash between two claimants names both.
 */
export const assertDistinct = <T>(
  what: string,
  items: ReadonlyArray<T>,
  nameOf: (item: T) => string,
  claimantOf: (item: T) => string = nameOf,
): void => {
  const seen = new Map<string, string>();

  for (const item of items) {
    const name = nameOf(item);
    const claimant = claimantOf(item);
    const other = seen.get(name);

    if (other !== undefined) {
      const by = other === claimant ? "" : `, claimed by ${other} and ${claimant}`;

      throw new Error(`Duplicate ${what}: ${name}${by}`);
    }

    seen.set(name, claimant);
  }
};

/** The `_tag` strings a schema's encoding may carry: one per tagged member. */
const encodedTags = (ast: AST): ReadonlyArray<string> => {
  const encoded = toEncoded(ast);

  if (isUnion(encoded)) return encoded.types.flatMap(encodedTags);

  if (!isObjects(encoded)) return [];

  return encoded.propertySignatures.flatMap((property) =>
    property.name === "_tag" && isLiteral(property.type) && isString(property.type.literal)
      ? [property.type.literal]
      : [],
  );
};

/**
 * Refuse an application error that encodes with a built-in error's `_tag`: every endpoint
 * declares the built-in one at the same status, and a client decoding the answer could not
 * tell them apart. The built-in errors themselves are allowed, and declared once.
 */
export const assertOwnTags = (what: string, errors: Action.Any["errors"]): void => {
  // Computed per call, not when the module loads, so a client bundle, which never calls
  // it, drops it.
  const builtInTags = new Set(httpErrors.flatMap(({ ast }) => encodedTags(ast)));

  for (const error of errors) {
    if (httpErrors.some((builtIn) => builtIn === error)) continue;

    const tag = encodedTags(error.ast).find((candidate) => builtInTags.has(candidate));

    if (tag !== undefined) {
      throw new Error(`${what}: error _tag "${tag}" is built in; use Action.${tag}`);
    }
  }
};
