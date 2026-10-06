import { Cause, Context, Effect, Exit, Option, Predicate, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { type Refusal, refusals, statuses } from "./errors.js";

/** An RFC 6750 error description: printable ASCII but `"` and `\`. */
const description = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * An RFC 9110 challenge of `scheme` and the parameters given, each a quoted string whose `"`
 * and `\` are escaped: a metadata URL's query may hold a `\`.
 */
export const challenge = (
  scheme: string,
  parameters: ReadonlyArray<readonly [name: string, value: string | undefined]>,
): string => {
  const given = parameters.flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}="${value.replace(/["\\]/g, "\\$&")}"`],
  );

  return given.length === 0 ? scheme : `${scheme} ${given.join(", ")}`;
};

/** An RFC 6750 `Bearer` challenge of the parameters given. */
export const bearer = (
  parameters: ReadonlyArray<readonly [name: string, value: string | undefined]>,
): string => challenge("Bearer", parameters);

const Refusals = Schema.Union(refusals);

const encode = Schema.encodeSync(Refusals);

const isRefusal = Schema.is(Refusals);

/**
 * The RFC 6750 `insufficient_scope` challenge an OAuth client steps up on, for a `Forbidden`
 * naming scopes, naming the resource's metadata URL when there is one.
 */
const insufficientScope = (error: Refusal, metadataUrl: string | undefined): string | undefined =>
  Predicate.isTagged(error, "Forbidden") && error.scopes !== undefined
    ? bearer([
        ["error", "insufficient_scope"],
        ["scope", error.scopes.join(" ")],
        ["resource_metadata", metadataUrl],
        ["error_description", description.test(error.message) ? error.message : undefined],
      ])
    : undefined;

/** A refusal as its JSON with its status alone, as a scheme no OAuth client acts on answers it. */
export const plain = (error: Refusal): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(encode(error), { status: statuses[error._tag] });

/**
 * A refusal as its JSON with its status, as every endpoint declares it, and its
 * `insufficient_scope` challenge if it has one.
 */
export const answer = (
  error: Refusal,
  metadataUrl: string | undefined,
): HttpServerResponse.HttpServerResponse => {
  const response = plain(error);
  const scoped = insufficientScope(error, metadataUrl);

  return scoped === undefined
    ? response
    : HttpServerResponse.setHeader(response, "www-authenticate", scoped);
};

/** The step-up refusal a tool's call under `answerStepUp` failed with, which answers its request. */
class SteppedUp extends Context.Service<SteppedUp, Ref.Ref<Option.Option<Refusal>>>()(
  "effect-actions/SteppedUp",
) {}

/**
 * Whether `error` is a refusal an OAuth client acts on: `Unauthenticated`, or `Forbidden`
 * naming scopes.
 */
export const isStepUp = (error: unknown): error is Refusal =>
  isRefusal(error) && (!Predicate.isTagged(error, "Forbidden") || error.scopes !== undefined);

/**
 * A protected MCP tool's `call`, whose step-up refusal answers the request under a Bearer
 * descriptor's `answerStepUp`. Elsewhere it is `call` as it is.
 */
export const recordStepUp = <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.tapError(call, (error) =>
    isStepUp(error)
      ? Effect.flatMap(Effect.serviceOption(SteppedUp), (slot) =>
          Option.isSome(slot) ? Ref.set(slot.value, Option.some(error)) : Effect.void,
        )
      : Effect.void,
  );

/**
 * An MCP request, answered with the step-up refusal a tool's call in it failed with, its
 * status, JSON and challenge naming `metadataUrl`, however the request ended short of a defect
 * or an interruption: a tool's failure is a successful result, and MCP authorization requires
 * 401 or 403.
 */
export const answerStepUp = <E, R>(
  route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  metadataUrl: string | undefined,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Exclude<R, SteppedUp>> =>
  Effect.gen(function* () {
    const slot = yield* Ref.make(Option.none<Refusal>());
    const exit = yield* Effect.exit(Effect.provideService(route, SteppedUp, slot));
    const refused = yield* Ref.get(slot);

    // A defect or an interruption after the refusal is the route's own, answered as it is.
    const broken =
      Exit.isFailure(exit) && (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause));

    return Option.isSome(refused) && !broken ? answer(refused.value, metadataUrl) : yield* exit;
  });
