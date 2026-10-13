import { Cause, Context, Effect, Exit, Option, Predicate, Ref, Schema, SchemaAST } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiSchema } from "effect/http-api";
import type * as Action from "../contract/Action.js";
import { Forbidden, Refusal, Unauthenticated } from "../contract/errors.js";
import { unsuspended } from "../contract/rules.js";

const httpApiStatusOf = SchemaAST.resolveAt<number>("httpApiStatus");

const statusThroughSuspensions = (ast: SchemaAST.AST): number | undefined =>
  httpApiStatusOf(ast) ??
  (SchemaAST.isSuspend(ast) ? statusThroughSuspensions(ast.thunk()) : undefined);

type Declared = Action.Errors[number];

/**
 * `error` as an endpoint declares it: each member of a union without a status of its own apart,
 * each with its status, 422 without one.
 */
export const declared = (error: Declared): ReadonlyArray<Declared> => {
  const status = statusThroughSuspensions(error.ast);

  if (status !== undefined) {
    return [httpApiStatusOf(error.ast) === undefined ? HttpApiSchema.status(status)(error) : error];
  }

  const resolved = unsuspended(error.ast);

  if (
    SchemaAST.isUnion(resolved) &&
    resolved.checks === undefined &&
    resolved.encoding === undefined
  ) {
    return resolved.types.flatMap((member) => declared(Schema.make<Declared>(member)));
  }

  return [HttpApiSchema.status(422)(error)];
};

const responseOf = (schema: Declared, error: Declared["Type"]) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeUnknownSync(Schema.toCodecJson(schema))(error), {
    status: httpApiStatusOf(schema.ast) ?? 422,
  });

/** `error` answered as an endpoint declaring `errors` answers it, if one of them declares it. */
export const declaredResponse = (
  errors: ReadonlyArray<Declared>,
  error: Declared["Type"],
): HttpServerResponse.HttpServerResponse | undefined => {
  const schema = errors.flatMap(declared).find((each) => Schema.is(each)(error));

  return schema === undefined ? undefined : responseOf(schema, error);
};

const rfc6750ErrorDescriptionCharacters = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;

export const challenge = (
  scheme: string,
  parameters: ReadonlyArray<readonly [name: string, value: string | undefined]>,
): string => {
  const given = parameters.flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}="${value.replace(/["\\]/g, "\\$&")}"`],
  );

  return given.length === 0 ? scheme : `${scheme} ${given.join(", ")}`;
};

export const bearer = (
  parameters: ReadonlyArray<readonly [name: string, value: string | undefined]>,
): string => challenge("Bearer", parameters);

export const isRefusal = Schema.is(Refusal);

const insufficientScopeChallenge = (
  error: Refusal,
  metadataUrl: string | undefined,
): string | undefined =>
  Predicate.isTagged(error, "Forbidden") && error.scopes !== undefined
    ? bearer([
        ["error", "insufficient_scope"],
        ["scope", error.scopes.join(" ")],
        ["resource_metadata", metadataUrl],
        [
          "error_description",
          rfc6750ErrorDescriptionCharacters.test(error.message) ? error.message : undefined,
        ],
      ])
    : undefined;

export const plain = (error: Refusal): HttpServerResponse.HttpServerResponse =>
  responseOf(Schema.is(Forbidden)(error) ? Forbidden : Unauthenticated, error);

export const answer = (
  error: Refusal,
  metadataUrl: string | undefined,
): HttpServerResponse.HttpServerResponse => {
  const response = plain(error);
  const scoped = insufficientScopeChallenge(error, metadataUrl);

  return scoped === undefined
    ? response
    : HttpServerResponse.setHeader(response, "www-authenticate", scoped);
};

class SteppedUpRefusal extends Context.Service<SteppedUpRefusal, Ref.Ref<Option.Option<Refusal>>>()(
  "effect-actions/SteppedUp",
) {}

export const isStepUp = (error: unknown): error is Refusal =>
  isRefusal(error) && (!Predicate.isTagged(error, "Forbidden") || error.scopes !== undefined);

export const recordStepUp = <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.tapError(call, (error) =>
    isStepUp(error)
      ? Effect.flatMap(Effect.serviceOption(SteppedUpRefusal), (slot) =>
          Option.isSome(slot) ? Ref.set(slot.value, Option.some(error)) : Effect.void,
        )
      : Effect.void,
  );

export const answerStepUp = <E, R>(
  route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  metadataUrl: string | undefined,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Exclude<R, SteppedUpRefusal>> =>
  Effect.gen(function* () {
    const slot = yield* Ref.make(Option.none<Refusal>());
    const exit = yield* Effect.exit(Effect.provideService(route, SteppedUpRefusal, slot));
    const refused = yield* Ref.get(slot);

    const diedOrInterruptedAfterRefusal =
      Exit.isFailure(exit) && (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause));

    return Option.isSome(refused) && !diedOrInterruptedAfterRefusal
      ? answer(refused.value, metadataUrl)
      : yield* exit;
  });
