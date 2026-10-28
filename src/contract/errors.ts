import { Effect, Predicate, Schema, SchemaIssue } from "effect";

const defaultedMessage = (fallback: string) =>
  Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed(fallback)));

const Issue = Schema.Struct({
  path: Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
  message: Schema.String,
});

/**
 * One thing wrong with an input, as `InvalidInput.issues` lists it: where, as the keys and
 * indexes leading to it from the input's root, none for the input itself, and what the schema
 * expects there.
 */
export type Issue = (typeof Issue)["Type"];

const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * The request's input does not decode against the action's input: its message is the schema's
 * own description of what is wrong, and `issues` the same an issue at a time, for a caller that
 * points at a field. A handler fails with it, naming `issues` of its own, for input that decodes
 * but cannot be served, instead of declaring a second error for bad input.
 *
 * **Gotchas**
 *
 * - Raised by the library for input that does not decode, before `authorize` and the handler; what each surface answers is on `ActionHttp.layer`, `ActionMcp.layerHttp` and `runStdio`, `ActionRpc.layer`, `ActionToolkit.make` and `ActionCli.command`.
 * - Failed by a handler, it is answered as a declared error on every surface.
 * - What receives encoded input, a route, an MCP tool, an rpc, a CLI flag or `--input`, refuses an undeclared field with it, nested ones too, naming its path; a typed client drops such a field instead, as its JSDoc says.
 * - Its message and `issues` name paths and what the schema expects, never a field's value; a path names every key it passes through, a record's keys included, so never key a record by a secret such as an email or a token.
 * - A check's message, or a schema's `message` annotation, is sent as written: never put the input in one.
 */
export class InvalidInput extends Schema.TaggedError<
  InvalidInput,
  { readonly brand: unique symbol }
>()(
  "InvalidInput",
  {
    message: defaultedMessage("The input does not match the action's input."),
    issues: Schema.Array(Issue).pipe(
      Schema.withConstructorDefault(Effect.succeed([]))
    ),
  },
  { httpApiStatus: 400 }
) {
  declare private readonly "~declared in the action's error, or built in": unknown;

  /**
   * The `InvalidInput` for input that did not decode, as every surface answers it: the
   * schema's message, and each of its issues by path, for code that decodes input of its own,
   * such as a header or a route parameter:
   * `Schema.decodeUnknownEffect(schema)(value, { errors: "all" }).pipe(Effect.mapError(Action.InvalidInput.fromSchemaError))`.
   * A symbol key is sent as its string form, `Symbol(name)`, as JSON has no symbols, which
   * tells it from a string key of that name.
   */
  static readonly fromSchemaError = ({
    issue,
    message,
  }: Schema.SchemaError): InvalidInput =>
    new InvalidInput({
      message,
      issues: standardIssues(issue).issues.map((found) => ({
        path: (found.path ?? []).map((segment) => {
          const key = Predicate.isPropertyKey(segment) ? segment : segment.key;

          return Predicate.isSymbol(key) ? String(key) : key;
        }),
        message: found.message,
      })),
    });
}

/**
 * The caller is not authenticated: authentication refuses the credential, or an implementation's
 * `authorize` or a handler fails with it.
 *
 * **Gotchas**
 *
 * - Over HTTP its JSON with a 401: from authentication before the body is read, from a protected action's `authorize` or handler after the input is decoded, each with the scheme's challenge, none for an API key.
 * - Over MCP: from authentication, the same HTTP 401 in place of a JSON-RPC answer, before the arguments are decoded; from a protected tool's `authorize` or handler, the HTTP 401 with the challenge on an endpoint under Bearer, otherwise an `isError: true` tool result in a 200.
 * - Over RPC the typed failure, never a status; on a Toolkit and in a CLI as a declared error.
 * - From another service's client, such as `ActionHttp.client`, one passed on tells a caller whose token is valid to sign in again: map it to an error the action declares, or to a defect.
 */
export class Unauthenticated extends Schema.TaggedError<
  Unauthenticated,
  { readonly brand: unique symbol }
>()(
  "Unauthenticated",
  { message: defaultedMessage("Authentication is required.") },
  { httpApiStatus: 401 }
) {
  declare private readonly "~declared in the action's error, or built in": unknown;
}

export const scopeToken = /^[\u0021\u0023-\u005B\u005D-\u007E]+$/;

const ScopeToken = Schema.String.check(Schema.isPattern(scopeToken));

/**
 * The caller may not run this action: authentication refuses the credential, an
 * implementation's `authorize` refuses, or a handler fails with it. `scopes`, when given, are every OAuth scope the call needs: a refusal naming
 * them is answered with the `insufficient_scope` challenge an OAuth client re-authorizes on,
 * which only a server publishing discovery can follow up, so name them only where
 * re-authorizing can grant them; with fixed tokens, such as API keys, leave them out
 * (`scopes: []` is a type error).
 *
 * **Gotchas**
 *
 * - Over HTTP its JSON with a 403: from authentication before the body is read, from `authorize` or a handler after the input is decoded; on a protected route under Bearer, one naming `scopes` also carries the challenge.
 * - Over MCP, from authentication the HTTP 403 before the arguments are decoded; from `authorize` or a handler an `isError: true` tool result holding its JSON as text, in a **200**, not a 403; only on an endpoint under Bearer is a protected tool's refusal naming `scopes` the HTTP 403 with the challenge instead.
 * - Over RPC the typed failure, never a status or a challenge; on a Toolkit and in a CLI as a declared error.
 * - From another service's client, such as `ActionHttp.client`, one passed on becomes this server's own refusal: map it to an error the action declares, or to a defect.
 */
export class Forbidden extends Schema.TaggedError<
  Forbidden,
  { readonly brand: unique symbol }
>()(
  "Forbidden",
  {
    message: defaultedMessage("Not allowed."),
    scopes: Schema.optionalKey(Schema.NonEmptyArray(ScopeToken)),
  },
  { httpApiStatus: 403 }
) {
  declare private readonly "~declared in the action's error, or built in": unknown;
}

const refusals = [Unauthenticated, Forbidden] as const;

/**
 * What authentication or an implementation's `authorize` refuses a caller with, instead of
 * running a handler. As a schema, it tells a refusal apart: `Schema.is(Action.Refusal)(error)`.
 */
export const Refusal = Schema.Union(refusals);

/** A refusal: `Unauthenticated | Forbidden`. */
export type Refusal = (typeof Refusal)["Type"];

export const builtIns = [InvalidInput, ...refusals] as const;

/** The built-in failures' schemas. */
export type BuiltIns = (typeof builtIns)[number];

/** The built-in failures as one schema: `Schema.is(Action.BuiltIn)(error)`. */
export const BuiltIn = Schema.Union(builtIns);

/** A built-in failure: `InvalidInput | Refusal`. */
export type BuiltIn = (typeof BuiltIn)["Type"];
