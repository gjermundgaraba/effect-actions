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
 * - Raised by the library for input that does not decode: over HTTP a 400 with its JSON; over MCP an `isError: true` result, `Invalid parameters for tool '<name>': …`; over RPC and in a CLI the typed error; on a Toolkit an `AiError` whose `reason` is a `ToolParameterValidationError`, not this error.
 * - Failed by a handler, it is answered as a declared error on every surface, the Toolkit's `isFailure: true` result included.
 * - What receives encoded input, a route, a tool, an rpc, a CLI flag or `--input`, refuses an undeclared field with it, nested ones too, naming its path; a typed client drops the field as it encodes, and a Toolkit as it decodes a model's arguments.
 * - Its message and `issues` name paths and what the schema expects, never a field's value; a path names every key it passes through, a record's keys included, so never key a record by a secret such as an email or a token.
 * - A check's message, or a schema's `message` annotation, is sent as written: never put the input in one.
 */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  {
    message: defaultedMessage("The input does not match the action's input."),
    issues: Schema.Array(Issue).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
  },
  { httpApiStatus: 400 },
) {
  declare private readonly "~declared in the action's error, or built in": unknown;

  /**
   * The `InvalidInput` for input that did not decode, as every surface answers it: the
   * schema's message, and each of its issues by path, for code that decodes input of its own,
   * such as a header or a route parameter:
   * `Schema.decodeUnknownEffect(schema)(value, { errors: "all" }).pipe(Effect.mapError(Action.InvalidInput.fromSchemaError))`.
   * Neither carries a value of the input: decoding runs without `reportInput`, so no issue
   * holds one to format. A symbol key is sent as its string form, `Symbol(name)`, as JSON has
   * no symbols, which tells it from a string key of that name.
   */
  static readonly fromSchemaError = ({ issue, message }: Schema.SchemaError): InvalidInput =>
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
 * - Over HTTP its JSON with a 401: from authentication, with the scheme's challenge, before the body is read; from `authorize` or a handler, after the input is decoded, with the scheme's challenge, none for an API key.
 * - Over MCP: from authentication, the same HTTP 401 in place of a JSON-RPC answer, before the arguments are decoded; from a protected tool's `authorize` or handler, the HTTP 401 with the challenge on an endpoint under Bearer, unless a handler's notification has started the response, and otherwise an `isError: true` tool result in a 200.
 * - Over RPC the typed failure, never a status. A local surface, a Toolkit, a CLI command, `runStdio` or `client`, authenticates nothing: the host provides the identity.
 * - From another service's client, such as `ActionHttp.client`, one passed on tells a caller whose token is valid to sign in again: map it to an error the action declares, or to a defect.
 */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  { message: defaultedMessage("Authentication is required.") },
  { httpApiStatus: 401 },
) {
  declare private readonly "~declared in the action's error, or built in": unknown;
}

export const scopeToken = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

const ScopeToken = Schema.String.check(Schema.isPattern(scopeToken));

/**
 * The caller may not run this action: an implementation's `authorize` refuses, or a handler
 * fails with it. `scopes`, when given, are every OAuth scope the call needs: a refusal naming
 * them is answered with the `insufficient_scope` challenge an OAuth client re-authorizes on,
 * which only a server publishing discovery can follow up, so name them only where
 * re-authorizing can grant them; with fixed tokens, such as API keys, leave them out
 * (`scopes: []` is a type error).
 *
 * **Gotchas**
 *
 * - Over HTTP its JSON with a 403, after the input is decoded; on a protected route under Bearer, one naming `scopes` also carries the challenge.
 * - Over MCP an `isError: true` tool result holding its JSON as text, in a **200**, not a 403; only on an endpoint under Bearer is a protected tool's refusal naming `scopes` the HTTP 403 with the challenge instead, unless a handler's notification has started the response.
 * - Over RPC the typed failure, never a status or a challenge; on a Toolkit a result with `isFailure: true`, and in a CLI its JSON on stderr with exit 1, both as a declared error.
 * - From another service's client, such as `ActionHttp.client`, one passed on becomes this server's own refusal: map it to an error the action declares, or to a defect.
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {
    message: defaultedMessage("Not allowed."),
    scopes: Schema.optionalKey(Schema.NonEmptyArray(ScopeToken)),
  },
  { httpApiStatus: 403 },
) {
  declare private readonly "~declared in the action's error, or built in": unknown;
}

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
 * fail with: bad input, and every refusal. An action or a binding need not declare them; one listed is accepted.
 */
export const builtIns = [InvalidInput, ...refusals] as const;

/** The built-in failures' schemas. */
export type BuiltIns = (typeof builtIns)[number];

/** The built-in failures as one schema: `Schema.is(Action.BuiltIn)(error)`. */
export const BuiltIn = Schema.Union(builtIns);

/** A built-in failure: `InvalidInput | Refusal`. */
export type BuiltIn = (typeof BuiltIn)["Type"];
