import { Predicate, Schema, SchemaAST, type Types } from "effect";
import type * as Action from "./Action.js";
import { builtIns, statuses } from "./errors.js";

/**
 * The list an `error` option stands for: one schema, a list as given, or none, as
 * `HttpApiEndpoint` takes it.
 */
export const errorList = (
  error: Action.Errors[number] | Action.Errors | undefined,
): Action.Errors => (error === undefined ? [] : Schema.isSchema(error) ? [error] : error);

/** The list an `error` option of type `G` stands for: one schema is a list of one. */
type ListOf<G> = G extends Action.Errors ? G : readonly [G];

/**
 * The errors options `O` declare, as at run time: those `error` always gives, or, where it may
 * be absent, those it gives or none, so clients decode each that may arrive.
 */
export type ErrorsOf<O> = O extends unknown
  ? "error" extends keyof O
    ? O extends { readonly error: infer G extends Action.Errors | Action.Errors[number] }
      ? ListOf<G>
      : ListOf<Extract<O["error" & keyof O], Action.Errors | Action.Errors[number]>> | []
    : []
  : never;

/** `T` where it is one type, not a union: what a list's slot of type `T` surely holds. */
type Single<T> = true extends Types.IsUnion<T> ? never : T;

/**
 * The errors a binding of errors `E` surely declares: each slot of one error in a list of
 * fixed length, never one of an array of unknown length, which may be empty, nor of a list
 * `E` may be one of several.
 */
export type Certain<E extends Action.Errors> =
  true extends Types.IsUnion<E>
    ? never
    : number extends E["length"]
      ? never
      : { readonly [K in keyof E]: Single<E[K]> }[number];

/**
 * What a projection of an action declares: the built-in errors, the action's own, and any
 * its surface adds, such as a binding's. The built-ins come first, since a failure encodes
 * and decodes with the first schema that accepts it, and they are classes, which accept
 * only their own instances: a loose schema of the action's never captures one. A schema
 * listed twice is not repeated.
 */
export const projectedErrors = (action: Action.Any, surface: Action.Errors = []): Action.Errors => [
  ...new Set([...builtIns, ...action.error, ...surface]),
];

/**
 * The caller of a public action, `caller: Action.Anyone`: anyone, signed in or not, and no
 * authorizer runs for it. Registered globally, so two copies of the package agree on it, as they
 * agree on a name.
 */
export const Anyone: unique symbol = Symbol.for("@gjermundgaraba/effect-actions/Anyone");

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

const encodedTags = (ast: SchemaAST.AST): ReadonlyArray<string> =>
  members(SchemaAST.toEncoded(ast)).flatMap((member) => {
    const tag = SchemaAST.isObjects(member)
      ? member.propertySignatures.find((property) => property.name === "_tag")?.type
      : undefined;

    return tag === undefined ? [] : members(tag).flatMap(literalValues).filter(Predicate.isString);
  });

/**
 * Refuse an error that encodes with a built-in error's `_tag`, the built-in itself included:
 * every endpoint and tool declares the built-in errors already, a client decoding the answer
 * could not tell a look-alike from them, and a look-alike of a refusal would step up. Checked
 * where the action or the binding is made, so every surface and client of it may rely on it.
 */
export const assertOwnTags = (what: string, errors: Action.Errors): void => {
  const tag = errors
    .flatMap((error) => encodedTags(error.ast))
    .find((tag) => Object.hasOwn(statuses, tag));

  if (tag !== undefined) {
    throw new Error(`${what}: error _tag "${tag}" is built in, and declared on every surface`);
  }
};
