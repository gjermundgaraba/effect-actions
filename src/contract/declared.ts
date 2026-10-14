import { Predicate, Schema, SchemaAST, type Types } from "effect";
import type * as Action from "./Action.js";
import { literalValues, members } from "./ast.js";
import { Anyone, assertAuthentication, type Proving } from "./caller.js";
import { builtIns } from "./errors.js";
import { assertOnce } from "./names.js";

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

const builtInTags = new Set(builtIns.flatMap((error) => encodedTags(error.ast)));

export const assertOwnTags = (what: string, errors: Action.Errors): void => {
  const tag = errors.flatMap((error) => encodedTags(error.ast)).find((tag) => builtInTags.has(tag));

  if (tag !== undefined) {
    throw new Error(`${what}: error _tag "${tag}" is built in, and declared on every surface`);
  }
};

/**
 * The checks `ActionHttp.make` and `ActionRpc.make` share: each action once, no built-in error in
 * `error`, and the descriptor every protected action names. Returns `error` as a list.
 */
export const bindingOf = <D extends Proving>(
  what: string,
  actions: ReadonlyArray<Action.Any>,
  options: {
    readonly error?: Action.Errors | Action.Errors[number] | undefined;
    readonly authentication?: D | undefined;
  },
) => {
  assertOnce("action", actions);

  const error = errorList(options.error);

  assertOwnTags(what, error);
  assertAuthentication(actions, options.authentication);

  return { error, authentication: options.authentication };
};
