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

/** The caller is not authenticated: an implementation's `authenticate` or `before` hook refuses. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  { message: message("Authentication is required.") },
  { httpApiStatus: statuses.Unauthenticated },
) {}

/** The caller may not run this action: an implementation's `before` hook refuses. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: message("Not allowed.") },
  { httpApiStatus: statuses.Forbidden },
) {}

/**
 * What a surface refuses with instead of running a handler. Every endpoint and tool
 * declares them, so clients decode them as typed failures.
 */
export type Refusal = Unauthenticated | Forbidden;

/** The refusals a tool surface declares on every tool: a `before` hook's failures. */
export const refusals = [Unauthenticated, Forbidden] as const;

/** What HTTP declares on every endpoint: bad input, and every refusal. */
export const httpErrors = [InvalidInput, ...refusals] as const;

/** The schemas every tool declares beyond its action's own errors. */
export type ToolErrors = (typeof refusals)[number];

/** The schemas every endpoint declares beyond its action's own errors. */
export type HttpErrors = (typeof httpErrors)[number];
