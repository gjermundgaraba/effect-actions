import { Predicate, Schema, SchemaAST } from "effect";
import type { Types } from "effect";

import type * as Action from "./Action.js";
import { literalValues, members } from "./ast.js";
import { Anyone, assertAuthentication } from "./caller.js";
import type { Called, Proving } from "./caller.js";
import { builtIns } from "./errors.js";
import { httpApiStatusOf } from "./status.js";

export const errorList = (
  error: Action.Errors[number] | Action.Errors | undefined
): Action.Errors => {
  if (error === undefined) {
    return [];
  }

  return Schema.isSchema(error) ? [error] : error;
};

type ListOf<G> = G extends Action.Errors ? G : readonly [G];

/**
 * The errors options `O` declare, as at run time: those `error` always gives, or, where it may
 * be absent, those it gives or none, so clients decode each that may arrive.
 */
export type ErrorsOf<O> = O extends unknown
  ? "error" extends keyof O
    ? O extends {
        readonly error: infer G extends Action.Errors | Action.Errors[number];
      }
      ? ListOf<G>
      :
          | ListOf<
              Extract<
                O["error" & keyof O],
                Action.Errors | Action.Errors[number]
              >
            >
          | []
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
  httpApiStatusOf(ast) === undefined &&
  ast.checks === undefined &&
  ast.encoding === undefined;

const schemasOf = (ast: SchemaAST.AST): readonly SchemaAST.AST[] => {
  if (!ownsNothing(ast)) {
    return [ast];
  }

  if (SchemaAST.isSuspend(ast)) {
    return schemasOf(ast.thunk());
  }

  return SchemaAST.isUnion(ast) ? ast.types.flatMap(schemasOf) : [ast];
};

export const errorSchemas = (errors: Action.Errors): Action.Errors => {
  const schemas = new Map<SchemaAST.AST, Action.Errors[number]>();

  for (const error of errors) {
    for (const ast of schemasOf(error.ast)) {
      if (!schemas.has(ast)) {
        schemas.set(
          ast,
          ast === error.ast ? error : Schema.make<Action.Errors[number]>(ast)
        );
      }
    }
  }

  return [...schemas.values()];
};

export const projectedErrors = (
  action: Pick<Action.Any, "error">,
  surface: Action.Errors = []
): Action.Errors => errorSchemas([...builtIns, ...action.error, ...surface]);

/** The errors a binding declares for every call, and its protected actions' authentication's. */
export interface Declaring {
  readonly error: Action.Errors;
  readonly authentication?: { readonly error: Action.Errors } | undefined;
}

export const bindingErrors = (
  action: Pick<Action.Any, "error" | "caller">,
  binding: Declaring
): Action.Errors =>
  projectedErrors(
    action,
    action.caller === Anyone || binding.authentication === undefined
      ? binding.error
      : [...binding.error, ...binding.authentication.error]
  );

export const eventErrors = (
  event: Pick<Called, "caller">,
  binding: Declaring
): Action.Errors => bindingErrors({ error: [], caller: event.caller }, binding);

const encodedTags = (ast: SchemaAST.AST): readonly string[] =>
  members(SchemaAST.toEncoded(ast)).flatMap((member) => {
    const tag = SchemaAST.isObjects(member)
      ? member.propertySignatures.find((property) => property.name === "_tag")
          ?.type
      : undefined;

    return tag === undefined
      ? []
      : members(tag).flatMap(literalValues).filter(Predicate.isString);
  });

const builtInTags = new Set(
  builtIns.flatMap((schema) => encodedTags(schema.ast))
);

export const assertDistinctTags = (
  what: string,
  errors: Action.Errors
): void => {
  const seen = new Set<string>();

  for (const schema of errorSchemas(errors)) {
    for (const tag of new Set(encodedTags(schema.ast))) {
      if (seen.has(tag)) {
        throw new Error(
          `${what}: error _tag "${tag}" names two error schemas, which a client cannot tell apart (reuse one schema value, or merge them into one whose fields tell them apart${
            builtInTags.has(tag)
              ? "; for a built-in's tag, fail with the built-in itself"
              : ""
          })`
        );
      }

      seen.add(tag);
    }
  }
};

export const bindingOf = <
  D extends Proving & { readonly error: Action.Errors },
>(
  what: string,
  actions: readonly Action.Any[],
  events: readonly Called[],
  options: {
    readonly error?: Action.Errors | Action.Errors[number] | undefined;
    readonly authentication?: D | undefined;
  }
) => {
  const error = errorList(options.error);

  const bound = { error, authentication: options.authentication };

  assertAuthentication(actions, bound.authentication);
  assertAuthentication(events, bound.authentication, "event");

  for (const action of actions) {
    assertDistinctTags(
      `${what} of "${action.name}"`,
      bindingErrors(action, bound)
    );
  }

  for (const event of events) {
    assertDistinctTags(
      `${what} of event "${event.name}"`,
      eventErrors(event, bound)
    );
  }

  return bound;
};
