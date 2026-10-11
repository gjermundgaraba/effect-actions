import { Cause, Context, Effect, Exit, Option, Predicate, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { Refusal, statuses } from "../contract/errors.js";

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

const encode = Schema.encodeSync(Refusal);

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
  HttpServerResponse.jsonUnsafe(encode(error), { status: statuses[error._tag] });

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
