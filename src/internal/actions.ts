import { Predicate, SchemaAST } from "effect";
import type * as Action from "../Action.js";
import { builtIns, statuses } from "./errors.js";

/**
 * What a projection of an action declares: the built-in errors, the action's own, and any
 * its surface adds, such as a binding's. The built-ins come first, since a failure encodes
 * and decodes with the first schema that accepts it, and they are classes, which accept
 * only their own instances: a loose schema of the action's never captures one. A schema
 * listed twice is not repeated.
 */
export const projectedErrors = (
  action: Action.Any,
  surface: Action.Any["errors"] = [],
): Action.Any["errors"] => [...new Set([...builtIns, ...action.errors, ...surface])];

/** Whether `T` is a union of several types. */
export type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

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

/** The `_tag`s a schema's encoding carries, one per member of a union. */
const tagsOf = (ast: SchemaAST.AST): ReadonlyArray<string> => {
  const encoded = SchemaAST.toEncoded(ast);

  if (SchemaAST.isUnion(encoded)) return encoded.types.flatMap(tagsOf);

  const tag = SchemaAST.isObjects(encoded)
    ? encoded.propertySignatures.find((property) => property.name === "_tag")?.type
    : undefined;

  return tag !== undefined && SchemaAST.isLiteral(tag) && Predicate.isString(tag.literal)
    ? [tag.literal]
    : [];
};

/**
 * Refuse an error that encodes with a built-in error's `_tag`, the built-in itself included:
 * every endpoint and tool declares the built-in errors already, and a client decoding the
 * answer could not tell a look-alike from them.
 */
export const assertOwnTags = (what: string, errors: Action.Any["errors"]): void => {
  const tag = errors
    .flatMap((error) => tagsOf(error.ast))
    .find((tag) => Object.hasOwn(statuses, tag));

  if (tag !== undefined) {
    throw new Error(`${what}: error _tag "${tag}" is built in, and declared on every surface`);
  }
};

/**
 * Refuse two errors one caller may receive with one `_tag`: a client decodes an answer by
 * trying the schemas declared for its status, and would take one for the other.
 */
export const assertDistinctTags = (what: string, errors: Action.Any["errors"]): void =>
  assertDistinct(
    `error _tag in ${what}`,
    [...new Set(errors)].flatMap((error) => tagsOf(error.ast)),
    (tag) => tag,
  );
