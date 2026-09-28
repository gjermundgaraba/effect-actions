// Server-only, and a module of its own: a client bundle, which never serves, drops it whole.
import { Context, Effect, Option, Predicate, Ref, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { type Refusal, refusals, statuses } from "./errors.js";

/**
 * The RFC 9728 metadata URL of the protected resource a request is authenticated for,
 * provided by `Authentication.make` when it publishes one: every challenge under it names
 * the URL.
 */
export class ResourceMetadata extends Context.Service<ResourceMetadata, string>()(
  "effect-actions/ResourceMetadata",
) {}

/** An RFC 6750 error description: printable ASCII but `"` and `\`. */
const description = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;

/** An RFC 6750 `Bearer` challenge of the parameters given, each a quoted string. */
export const bearer = (
  parameters: ReadonlyArray<readonly [name: string, value: string | undefined]>,
): string => {
  const given = parameters.flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}="${value}"`],
  );

  return given.length === 0 ? "Bearer" : `Bearer ${given.join(", ")}`;
};

const Refusals = Schema.Union(refusals);

const encode = Schema.encodeSync(Refusals);

/**
 * A refusal as its JSON with its status, as every endpoint declares it. A `Forbidden` naming
 * scopes carries the RFC 6750 `insufficient_scope` challenge an OAuth client steps up on,
 * naming the resource's metadata URL when there is one.
 */
export const answer = (
  error: Refusal,
  metadataUrl: string | undefined,
): HttpServerResponse.HttpServerResponse => {
  const response = HttpServerResponse.jsonUnsafe(encode(error), { status: statuses[error._tag] });

  if (!Predicate.isTagged(error, "Forbidden") || error.scopes === undefined) return response;

  return HttpServerResponse.setHeader(
    response,
    "www-authenticate",
    bearer([
      ["error", "insufficient_scope"],
      ["scope", error.scopes.join(" ")],
      ["resource_metadata", metadataUrl],
      ["error_description", description.test(error.message) ? error.message : undefined],
    ]),
  );
};

/** `answer`, naming the metadata URL of the resource `Authentication.make` covers the request for. */
const refuse = (error: Refusal): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.map(Effect.serviceOption(ResourceMetadata), (metadata) =>
    answer(error, Option.getOrUndefined(metadata)),
  );

const isRefusal = Schema.is(Refusals);

/** The step-up refusal a call under `stepUp` failed with, which answers its request. */
class SteppedUp extends Context.Service<SteppedUp, Ref.Ref<Option.Option<Refusal>>>()(
  "effect-actions/SteppedUp",
) {}

/**
 * `call`, whose failure, when an OAuth client acts on it (`Unauthenticated`, or `Forbidden`
 * naming scopes), answers the request under `stepUp`. Elsewhere, such as over stdio, it is
 * `call` as it is.
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
 * Route middleware answering a request whose call failed with a step-up refusal with the
 * refusal's status and challenge, whatever the route answered: 401 or 403 as MCP
 * authorization requires, where MCP would answer a tool result.
 */
export const stepUp = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const slot = yield* Ref.make(Option.none<Refusal>());
    const response = yield* Effect.provideService(httpEffect, SteppedUp, slot);
    const refused = yield* Ref.get(slot);

    return Option.isSome(refused) ? yield* refuse(refused.value) : response;
  }),
).layer;
