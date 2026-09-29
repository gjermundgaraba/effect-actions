import { Context, Effect, Option, Predicate, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { type Refusal, refusals, statuses } from "./errors.js";

/** An RFC 6750 error description: printable ASCII but `"` and `\`. */
const description = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * An RFC 6750 `Bearer` challenge of the parameters given, each a quoted string whose `"` and
 * `\` are escaped: a metadata URL's query may hold a `\`.
 */
export const bearer = (
  parameters: ReadonlyArray<readonly [name: string, value: string | undefined]>,
): string => {
  const given = parameters.flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}="${value.replace(/["\\]/g, "\\$&")}"`],
  );

  return given.length === 0 ? "Bearer" : `Bearer ${given.join(", ")}`;
};

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

/**
 * A refusal as its JSON with its status, as every endpoint declares it, and its
 * `insufficient_scope` challenge if it has one.
 */
export const answer = (
  error: Refusal,
  metadataUrl: string | undefined,
): HttpServerResponse.HttpServerResponse => {
  const response = HttpServerResponse.jsonUnsafe(encode(error), { status: statuses[error._tag] });
  const challenge = insufficientScope(error, metadataUrl);

  return challenge === undefined
    ? response
    : HttpServerResponse.setHeader(response, "www-authenticate", challenge);
};

/** The step-up refusal a call under `answerStepUp` failed with, which answers its request. */
class SteppedUp extends Context.Service<SteppedUp, Ref.Ref<Option.Option<Refusal>>>()(
  "effect-actions/SteppedUp",
) {}

/**
 * `call`, whose failure, when an OAuth client acts on it (`Unauthenticated`, or `Forbidden`
 * naming scopes), answers the request under `answerStepUp`. Elsewhere, such as without
 * `Authentication.make` or over stdio, it is `call` as it is.
 */
export const recordStepUp = <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.tapError(call, (error) =>
    isRefusal(error) && (!Predicate.isTagged(error, "Forbidden") || error.scopes !== undefined)
      ? Effect.flatMap(Effect.serviceOption(SteppedUp), (slot) =>
          Option.isSome(slot) ? Ref.set(slot.value, Option.some(error)) : Effect.void,
        )
      : Effect.void,
  );

/**
 * `route`, answered, when a call in it failed with a step-up refusal, with the refusal's
 * status, JSON and challenge, naming `metadataUrl`, whatever the route answered: an HTTP
 * route's own refusal, or an MCP tool result, where MCP authorization requires 401 or 403.
 */
export const answerStepUp = <E, R>(
  route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  metadataUrl: string | undefined,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Exclude<R, SteppedUp>> =>
  Effect.gen(function* () {
    const slot = yield* Ref.make(Option.none<Refusal>());
    const response = yield* Effect.provideService(route, SteppedUp, slot);
    const refused = yield* Ref.get(slot);

    return Option.isSome(refused) ? answer(refused.value, metadataUrl) : response;
  });
