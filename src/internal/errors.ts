import { Effect, Schema } from "effect";

/** A message field that defaults, so `new Forbidden()` needs no argument. */
const message = (fallback: string) =>
  Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed(fallback)));

/** Each built-in error's HTTP status, by tag: its annotation, and what a refusal answers. */
export const statuses = { InvalidInput: 400, Unauthenticated: 401, Forbidden: 403 } as const;

/**
 * The request's input does not decode against the action's input. HTTP answers every such
 * request with it, its message the schema's own description of what is wrong.
 */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  { message: message("The input does not match the action's input.") },
  { httpApiStatus: statuses.InvalidInput },
) {}

/** The caller is not authenticated: authentication or an implementation's `before` hook refuses. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  { message: message("Authentication is required.") },
  { httpApiStatus: statuses.Unauthenticated },
) {}

/** An OAuth scope token (RFC 6749 §3.3): printable ASCII but space, `"` and `\`. */
export const scopeToken = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

const ScopeToken = Schema.String.check(Schema.isPattern(scopeToken));

/**
 * The caller may not run this action: an implementation's `before` hook refuses. `scopes`,
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
) {}

/**
 * What authentication or a `before` hook refuses a caller with, instead of running a handler.
 * A hook may also fail with an error its actions declare, which is not a refusal.
 */
export type Refusal = Unauthenticated | Forbidden;

/** The refusals, as schemas. */
export const refusals = [Unauthenticated, Forbidden] as const;

/**
 * The failures every endpoint and tool declares beyond its action's own, and any handler may
 * fail with: bad input, and every refusal. No action or binding declares them itself.
 */
export const builtIns = [InvalidInput, ...refusals] as const;

/** The built-in failures' schemas. */
export type BuiltIns = (typeof builtIns)[number];

/** A built-in failure. */
export type BuiltIn = InvalidInput | Refusal;
