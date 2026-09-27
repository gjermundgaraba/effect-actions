// Server-only, and a module of its own: a client bundle, which never serves, drops it whole.
import { Context, Effect, Option, Predicate, Schema, type Types } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { type Refusal, refusals, statuses } from "./errors.js";
import { acquire, type AnyImplementation, Authorized, type Bound } from "./implementation.js";

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

/**
 * A refusal as its JSON with its status, as every endpoint declares it. A `Forbidden` naming
 * scopes carries the RFC 6750 `insufficient_scope` challenge an OAuth client steps up on,
 * naming the resource's metadata URL under `Authentication.make`.
 */
export const refuse = (error: Refusal): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.gen(function* () {
    const response = yield* HttpServerResponse.schemaJson(Refusals)(error, {
      status: statuses[error._tag],
    }).pipe(Effect.orDie);

    if (!Predicate.isTagged(error, "Forbidden") || error.scopes === undefined) return response;

    const metadata = yield* Effect.serviceOption(ResourceMetadata);

    return HttpServerResponse.setHeader(
      response,
      "www-authenticate",
      bearer([
        ["error", "insufficient_scope"],
        ["scope", error.scopes.join(" ")],
        ["resource_metadata", Option.getOrUndefined(metadata)],
        ["error_description", description.test(error.message) ? error.message : undefined],
      ]),
    );
  });

/** Which bound action, if any, a request calls: known from its route and headers alone. */
export type Select = (
  request: HttpServerRequest.HttpServerRequest,
  route: HttpRouter.Route<unknown, unknown>,
) => Bound[number] | undefined;

/**
 * Route middleware running the hook of the action a request calls before the route decodes
 * anything: a refusal is answered with its status, and an allowed call marks its action
 * `Authorized`, so its handler does not run the hook again. A request it cannot attribute
 * to an action passes, and its handler runs the hook itself. It needs the handlers of
 * `apps`, which `provideHandlers` provides.
 */
export const preflight = (
  apps: ReadonlyArray<AnyImplementation>,
  selectOf: (bound: Bound) => Select,
) =>
  HttpRouter.middleware(
    Effect.map(acquire(apps), (bound) => {
      const select = selectOf(bound);

      return (httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { route } = yield* HttpRouter.RouteContext;
          const called = select(request, route);

          if (called === undefined) return yield* httpEffect;

          const [action, , hook] = called;

          // SAFETY: a hook fails only with a refusal, as `Before` types it, and its services
          // are request requirements of the routes this covers, which each surface's
          // signature states.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased hook boundary.
          const authorize = hook as Effect.Effect<void, Refusal>;

          return yield* authorize.pipe(
            Effect.matchEffect({
              onFailure: refuse,
              onSuccess: () => Effect.provideService(httpEffect, Authorized, action),
            }),
          );
        });
    }),
  ).layer;
