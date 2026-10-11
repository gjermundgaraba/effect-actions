import { Predicate, Schema, SchemaAST, type Types } from "effect";
import type * as Action from "./Action.js";
import { builtIns, statuses } from "./errors.js";

export const errorList = (
  error: Action.Errors[number] | Action.Errors | undefined,
): Action.Errors => (error === undefined ? [] : Schema.isSchema(error) ? [error] : error);

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

export const assertName = (what: string, name: string): void => {
  if (!validName.test(name) || name === "then") throw new Error(`Invalid ${what}: ${name}`);
};

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

export const assertOnce = (what: string, actions: ReadonlyArray<Action.Any>): void =>
  assertDistinct(what, actions, (action) => action.name);

export const assertKnown = (
  what: string,
  keys: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
): void => {
  const unknown = keys.filter((key) => !names.includes(key));

  if (unknown.length > 0) throw new Error(`Unknown ${what}: ${unknown.join(", ")}`);
};

export const unsuspended = (ast: SchemaAST.AST): SchemaAST.AST =>
  SchemaAST.isSuspend(ast) ? unsuspended(ast.thunk()) : ast;

export const members = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> => {
  const resolved = unsuspended(ast);

  return SchemaAST.isUnion(resolved) ? resolved.types.flatMap(members) : [resolved];
};

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

export const assertOwnTags = (what: string, errors: Action.Errors): void => {
  const tag = errors
    .flatMap((error) => encodedTags(error.ast))
    .find((tag) => Object.hasOwn(statuses, tag));

  if (tag !== undefined) {
    throw new Error(`${what}: error _tag "${tag}" is built in, and declared on every surface`);
  }
};
