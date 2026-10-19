import { Predicate, Schema, SchemaAST, type Types } from "effect";
import type * as Action from "./Action.js";
import { literalValues, members } from "./ast.js";
import { Anyone, assertAuthentication, type Proving } from "./caller.js";
import { builtIns } from "./errors.js";
import { assertOnce } from "./names.js";
import { httpApiStatusOf } from "./status.js";

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

const ownsNothing = (ast: SchemaAST.AST): boolean =>
  httpApiStatusOf(ast) === undefined && ast.checks === undefined && ast.encoding === undefined;

const schemasOf = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  !ownsNothing(ast)
    ? [ast]
    : SchemaAST.isSuspend(ast)
      ? schemasOf(ast.thunk())
      : SchemaAST.isUnion(ast)
        ? ast.types.flatMap(schemasOf)
        : [ast];

// Why: A union or `Schema.suspend` without a status, checks or a transformation of its own decodes
// as what it holds, and HTTP gives each member its own status; one with any of them is one schema.
// Listed apart, each schema is declared once however often it is reached, through a union, a
// `Schema.suspend` or several sources, so an endpoint and its OpenAPI document name it once.
/** `errors` as the schemas a call decodes a failure with, in order, each once. */
export const errorSchemas = (errors: Action.Errors): Action.Errors => {
  const schemas = new Map<SchemaAST.AST, Action.Errors[number]>();

  for (const error of errors) {
    for (const ast of schemasOf(error.ast)) {
      if (!schemas.has(ast)) {
        schemas.set(ast, ast === error.ast ? error : Schema.make<Action.Errors[number]>(ast));
      }
    }
  }

  return [...schemas.values()];
};

export const projectedErrors = (action: Action.Any, surface: Action.Errors = []): Action.Errors =>
  errorSchemas([...builtIns, ...action.error, ...surface]);

/** The errors a binding declares for every call, and its protected actions' authentication's. */
export interface Declaring {
  readonly error: Action.Errors;
  readonly authentication?: { readonly error: Action.Errors } | undefined;
}

// Why: A surface adds a verifier's errors to its protected actions itself, as it adds its own,
// so they take the status rule, the projected order and the client types of every other error.
// Rejected: the HTTP security middleware's native `error`, which `HttpApiEndpoint` merges in.
/**
 * Every error a binding's call of `action` declares: the built-in ones, the action's, the
 * binding's and, where `action` is protected, its authentication's.
 */
export const bindingErrors = (action: Action.Any, binding: Declaring): Action.Errors =>
  projectedErrors(
    action,
    action.caller === Anyone || binding.authentication === undefined
      ? binding.error
      : [...binding.error, ...binding.authentication.error],
  );

const encodedTags = (ast: SchemaAST.AST): ReadonlyArray<string> =>
  members(SchemaAST.toEncoded(ast)).flatMap((member) => {
    const tag = SchemaAST.isObjects(member)
      ? member.propertySignatures.find((property) => property.name === "_tag")?.type
      : undefined;

    return tag === undefined ? [] : members(tag).flatMap(literalValues).filter(Predicate.isString);
  });

// Why: The library joins one call's errors, the built-in ones, the action's, the binding's and the
// authentication's, and a client decodes a failure as the first schema that accepts it, so two
// schemas sharing a `_tag` misdecode wherever one accepts the other's values. Effect's `catchTag`
// cannot tell them apart either. A schema's own variants, behind a transformation, are its own.
/** Throws where two of the schemas `errors` decode with encode with one `_tag`. */
export const assertDistinctTags = (what: string, errors: Action.Errors): void => {
  const seen = new Set<string>();
  const builtInTags = new Set(builtIns.flatMap((schema) => encodedTags(schema.ast)));

  for (const schema of errorSchemas(errors)) {
    for (const tag of new Set(encodedTags(schema.ast))) {
      if (seen.has(tag)) {
        throw new Error(
          `${what}: error _tag "${tag}" names two error schemas, which a client cannot tell apart (reuse one schema value, or merge them into one whose fields tell them apart${
            builtInTags.has(tag) ? "; for a built-in's tag, fail with the built-in itself" : ""
          })`,
        );
      }

      seen.add(tag);
    }
  }
};

/**
 * The checks `ActionHttp.make` and `ActionRpc.make` share: each action once, the descriptor every
 * protected action names, and each call's errors distinct by `_tag`. Returns the binding's `error`, as a list, and `authentication`.
 */
export const bindingOf = <D extends Proving & { readonly error: Action.Errors }>(
  what: string,
  actions: ReadonlyArray<Action.Any>,
  options: {
    readonly error?: Action.Errors | Action.Errors[number] | undefined;
    readonly authentication?: D | undefined;
  },
) => {
  assertOnce("action", actions);

  const error = errorList(options.error);

  const bound = { error, authentication: options.authentication };

  assertAuthentication(actions, bound.authentication);

  for (const action of actions) {
    assertDistinctTags(`${what} of "${action.name}"`, bindingErrors(action, bound));
  }

  return bound;
};
