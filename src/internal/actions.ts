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

/** Refuse an action name `actions` hold twice. */
export const assertOnce = (what: string, actions: ReadonlyArray<Action.Any>): void =>
  assertDistinct(what, actions, (action) => action.name);

/**
 * Refuse a key of options keyed by action name, such as handlers, tools or commands, that no
 * action of `names` has, so a stale option cannot outlive its action.
 */
export const assertKnown = (
  what: string,
  keys: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
): void => {
  const unknown = keys.filter((key) => !names.includes(key));

  if (unknown.length > 0) throw new Error(`Unknown ${what}: ${unknown.join(", ")}`);
};

/** `ast` with any suspension at its top resolved, as a recursive schema's is. */
export const unsuspended = (ast: SchemaAST.AST): SchemaAST.AST =>
  SchemaAST.isSuspend(ast) ? unsuspended(ast.thunk()) : ast;

/** The members of a union, nested and suspended ones included, or the one type otherwise. */
export const members = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> => {
  const resolved = unsuspended(ast);

  return SchemaAST.isUnion(resolved) ? resolved.types.flatMap(members) : [resolved];
};

/**
 * The values a literal or an enum accepts, or `undefined` for any other type, which has no
 * fixed set.
 */
export const literalValues = (ast: SchemaAST.AST): ReadonlyArray<unknown> =>
  SchemaAST.isLiteral(ast)
    ? [ast.literal]
    : SchemaAST.isEnum(ast)
      ? ast.enums.map(([, value]) => value)
      : [undefined];

/**
 * The `_tag`s a schema's encoding carries, each once: each member's of a union, every value of
 * a union of literals or of an enum, and a suspended schema's, as a recursive error is written.
 */
const tagsOf = (ast: SchemaAST.AST): ReadonlyArray<string> => {
  const tags = members(SchemaAST.toEncoded(ast)).flatMap((member) => {
    const tag = SchemaAST.isObjects(member)
      ? member.propertySignatures.find((property) => property.name === "_tag")?.type
      : undefined;

    return tag === undefined ? [] : members(tag).flatMap(literalValues).filter(Predicate.isString);
  });

  return [...new Set(tags)];
};

/**
 * Refuse an error that encodes with a built-in error's `_tag`, the built-in itself included:
 * every endpoint and tool declares the built-in errors already, and a client decoding the
 * answer could not tell a look-alike from them.
 */
const assertOwnTags = (what: string, errors: Action.Any["errors"]): void => {
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
const assertDistinctTags = (what: string, errors: Action.Any["errors"]): void =>
  assertDistinct(
    `error _tag in ${what}`,
    [...new Set(errors)].flatMap((error) => tagsOf(error.ast)),
    (tag) => tag,
  );

/**
 * Refuse errors a caller of `actions` could not tell apart, the binding's `errors` among them
 * over HTTP: one with a built-in error's `_tag`, and two of one action, or of one action and
 * its binding, with one `_tag`. Checked by every surface serving the actions and every client
 * calling them, rather than where an action is made, so a client of a contract no server here
 * serves refuses it too.
 */
export const assertErrors = (
  actions: ReadonlyArray<Action.Any>,
  binding: Action.Any["errors"] = [],
): void => {
  assertOwnTags("ActionHttp binding", binding);

  for (const action of actions) {
    assertOwnTags(`Action "${action.name}"`, action.errors);
    assertDistinctTags(
      binding.length === 0 ? `action "${action.name}"` : `action "${action.name}" and its binding`,
      [...action.errors, ...binding],
    );
  }
};
