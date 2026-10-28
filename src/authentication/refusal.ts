import {
  Cause,
  Context,
  Effect,
  Exit,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";
import { HttpServerResponse } from "effect/http";

import type * as Action from "../contract/Action.js";
import { errorSchemas } from "../contract/declared.js";
import { Forbidden, Refusal, Unauthenticated } from "../contract/errors.js";
import { declared, httpApiStatusOf } from "../contract/status.js";

type Declared = Action.Errors[number];

const responseOf = (schema: Declared, error: Declared["Type"]) =>
  HttpServerResponse.jsonUnsafe(
    Schema.encodeUnknownSync(Schema.toCodecJson(schema))(error),
    {
      status: httpApiStatusOf(schema.ast) ?? 422,
    }
  );

export const declaredResponse = (
  errors: readonly Declared[],
  error: Declared["Type"]
): HttpServerResponse.HttpServerResponse | undefined => {
  const schema = errorSchemas(errors)
    .map(declared)
    .find((each) => Schema.is(each)(error));

  return schema === undefined ? undefined : responseOf(schema, error);
};

const rfc6750ErrorDescriptionCharacters =
  /^[\u0020\u0021\u0023-\u005B\u005D-\u007E]+$/u;

export const challenge = (
  scheme: string,
  parameters: ReadonlyArray<readonly [name: string, value: string | undefined]>
): string => {
  const given = parameters.flatMap(([name, value]) =>
    value === undefined
      ? []
      : [`${name}="${value.replaceAll(/["\\]/gu, "\\$&")}"`]
  );

  return given.length === 0 ? scheme : `${scheme} ${given.join(", ")}`;
};

export const bearer = (
  parameters: ReadonlyArray<readonly [name: string, value: string | undefined]>
): string => challenge("Bearer", parameters);

export const isRefusal = Schema.is(Refusal);

const insufficientScopeChallenge = (
  error: Refusal,
  metadataUrl: string | undefined
): string | undefined =>
  Predicate.isTagged(error, "Forbidden") && error.scopes !== undefined
    ? bearer([
        ["error", "insufficient_scope"],
        ["scope", error.scopes.join(" ")],
        ["resource_metadata", metadataUrl],
        [
          "error_description",
          rfc6750ErrorDescriptionCharacters.test(error.message)
            ? error.message
            : undefined,
        ],
      ])
    : undefined;

const refusalSchemas = {
  Unauthenticated,
  Forbidden,
} satisfies { readonly [Tag in Refusal["_tag"]]: Declared };

export const plain = (error: Refusal): HttpServerResponse.HttpServerResponse =>
  responseOf(refusalSchemas[error._tag], error);

export const answer = (
  error: Refusal,
  metadataUrl: string | undefined
): HttpServerResponse.HttpServerResponse => {
  const response = plain(error);
  const scoped = insufficientScopeChallenge(error, metadataUrl);

  return scoped === undefined
    ? response
    : HttpServerResponse.setHeader(response, "www-authenticate", scoped);
};

class SteppedUpRefusal extends Context.Service<
  SteppedUpRefusal,
  Ref.Ref<Option.Option<Refusal>>
>()("effect-actions/SteppedUp") {}

export const isStepUp = <E>(error: E): error is E & Refusal =>
  isRefusal(error) &&
  (!Predicate.isTagged(error, "Forbidden") || error.scopes !== undefined);

export const recordStepUp = <A, E, R>(
  call: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.tapError(call, (error) =>
    isStepUp(error)
      ? Effect.flatMap(Effect.serviceOption(SteppedUpRefusal), (slot) =>
          Option.isSome(slot)
            ? Ref.set(slot.value, Option.some(error))
            : Effect.void
        )
      : Effect.void
  );

export const answerStepUp = <E, R>(
  route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  metadataUrl: string | undefined
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  Exclude<R, SteppedUpRefusal>
> =>
  Effect.gen(function* () {
    const slot = yield* Ref.make(Option.none<Refusal>());

    const exit = yield* Effect.exit(
      Effect.provideService(route, SteppedUpRefusal, slot)
    );

    const refused = yield* Ref.get(slot);

    const diedOrInterruptedAfterRefusal =
      Exit.isFailure(exit) &&
      (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause));

    return Option.isSome(refused) && !diedOrInterruptedAfterRefusal
      ? answer(refused.value, metadataUrl)
      : yield* exit;
  });
