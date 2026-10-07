import { Effect, Predicate, Schema, SchemaIssue } from "effect";

/** A message field that defaults, so `new Forbidden()` needs no argument. */
const message = (fallback: string) =>
  Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed(fallback)));

/** Each built-in error's HTTP status, by tag: its annotation, and what a refusal answers. */
export const statuses = { InvalidInput: 400, Unauthenticated: 401, Forbidden: 403 } as const;

/**
 * One thing wrong with an input: where, as the keys and indexes leading to it from the input's
 * root, none for the input itself, and what the schema expects there.
 */
const Issue = Schema.Struct({
  path: Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
  message: Schema.String,
});

/** One thing wrong with an input, as `InvalidInput.issues` lists it. */
export type Issue = (typeof Issue)["Type"];

const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * The request's input does not decode against the action's input. HTTP answers every such
 * request with it, its message the schema's own description of what is wrong, and `issues`
 * the same description an issue at a time, for a caller that points at a field. A handler
 * failing with it for input that decodes but cannot be served may name its own.
 */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  {
    message: message("The input does not match the action's input."),
    issues: Schema.Array(Issue).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
  },
  { httpApiStatus: statuses.InvalidInput },
) {
  // Type-only: a private member makes the class nominal, so an error of Effect's or the
  // application's with the same `_tag` and fields, which this class's codec does not encode,
  // does not compile as one.
  declare private readonly "~builtIn": unknown;

  /**
   * The `InvalidInput` for input that did not decode, as every surface answers it: the
   * schema's message, and each of its issues by path, for code that decodes input of its own,
   * such as a header or a route parameter. Neither carries a value of the input: decoding
   * runs without `reportInput`, so no issue holds one to format. A symbol key is sent as its
   * string form, `Symbol(name)`, as JSON has no symbols, which tells it from a string key of
   * that name.
   */
  static readonly fromSchemaError = ({ issue, message }: Schema.SchemaError): InvalidInput =>
    new InvalidInput({
      message,
      issues: standardIssues(issue).issues.map((found) => ({
        // The formatter is typed as Standard Schema's failure result, whose path is optional
        // and may hold `{ key }` segments.
        path: (found.path ?? []).map((segment) => {
          const key = Predicate.isPropertyKey(segment) ? segment : segment.key;

          return Predicate.isSymbol(key) ? String(key) : key;
        }),
        message: found.message,
      })),
    });
}

/** The caller is not authenticated: authentication or an implementation's `authorize` refuses. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  { message: message("Authentication is required.") },
  { httpApiStatus: statuses.Unauthenticated },
) {
  // Type-only: a private member makes the class nominal, so an error of Effect's or the
  // application's with the same `_tag` and fields, which this class's codec does not encode,
  // does not compile as one.
  declare private readonly "~builtIn": unknown;
}

/** An OAuth scope token (RFC 6749 §3.3): printable ASCII but space, `"` and `\`. */
export const scopeToken = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

const ScopeToken = Schema.String.check(Schema.isPattern(scopeToken));

/**
 * The caller may not run this action: an implementation's `authorize` refuses. `scopes`,
 * when given, are every OAuth scope the call needs: a refusal naming them is answered with
 * the `insufficient_scope` challenge an OAuth client re-authorizes on.
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {
    message: message("Not allowed."),
    scopes: Schema.optionalKey(Schema.NonEmptyArray(ScopeToken)),
  },
  { httpApiStatus: statuses.Forbidden },
) {
  // Type-only: a private member makes the class nominal, so an error of Effect's or the
  // application's with the same `_tag` and fields, which this class's codec does not encode,
  // does not compile as one.
  declare private readonly "~builtIn": unknown;
}

/** The refusals, as schemas. */
const refusals = [Unauthenticated, Forbidden] as const;

/**
 * What authentication or an implementation's `authorize` refuses a caller with, instead of
 * running a handler. An error an action declares, such as a rate limit, is not a refusal. As a
 * schema, it tells a refusal apart: `Schema.is(Action.Refusal)(error)`.
 */
export const Refusal = Schema.Union(refusals);

/** A refusal: `Unauthenticated | Forbidden`. */
export type Refusal = (typeof Refusal)["Type"];

/**
 * The failures every endpoint and tool declares beyond its action's own, and any handler may
 * fail with: bad input, and every refusal. No action or binding declares them itself.
 */
export const builtIns = [InvalidInput, ...refusals] as const;

/** The built-in failures' schemas. */
export type BuiltIns = (typeof builtIns)[number];

/** The built-in failures as one schema: `Schema.is(Action.BuiltIn)(error)`. */
export const BuiltIn = Schema.Union(builtIns);

/** A built-in failure: `InvalidInput | Refusal`. */
export type BuiltIn = (typeof BuiltIn)["Type"];
