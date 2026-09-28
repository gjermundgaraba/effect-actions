// Its own modules rather than the barrel's namespaces, which esbuild keeps whole in a client.
import { isString } from "effect/Predicate";
import { type AST, isLiteral, isObjects, isUnion, toEncoded } from "effect/SchemaAST";
import type * as Action from "../Action.js";
import { statuses } from "./errors.js";

/**
 * An action's own failures plus the ones its surface answers with, which is what
 * a projection of that action declares. A schema both declare, such as a binding error
 * the action lists too, is not repeated.
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

/** The built-in error's `_tag` a schema's encoding carries, of a member of a union included. */
const builtInTag = (ast: AST): string | undefined => {
  const encoded = toEncoded(ast);

  if (isUnion(encoded)) return encoded.types.map(builtInTag).find(isString);

  const tag = isObjects(encoded)
    ? encoded.propertySignatures.find((property) => property.name === "_tag")?.type
    : undefined;

  return tag !== undefined &&
    isLiteral(tag) &&
    isString(tag.literal) &&
    Object.hasOwn(statuses, tag.literal)
    ? tag.literal
    : undefined;
};

/**
 * Refuse an error that encodes with a built-in error's `_tag`, the built-in itself included:
 * every endpoint and tool declares the built-in errors already, and a client decoding the
 * answer could not tell a look-alike from them.
 */
export const assertOwnTags = (what: string, errors: Action.Any["errors"]): void => {
  for (const error of errors) {
    const tag = builtInTag(error.ast);

    if (tag !== undefined) {
      throw new Error(`${what}: error _tag "${tag}" is built in, and declared on every surface`);
    }
  }
};
