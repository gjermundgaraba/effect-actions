import { Context, Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";

/**
 * The workspace a request addresses, from its `X-Workspace` header. It is request context, not
 * an identity: the verifier reads it to decide which of an account's memberships the caller
 * acts in. Handlers never read it; they read the workspace of the authenticated member.
 */
export class Tenant extends Context.Service<Tenant, Option.Option<string>>()(
  "tracker/Tenant"
) {}

export const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()(
  (route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.provideService(
        route,
        Tenant,
        Option.fromNullishOr(request.headers["x-workspace"])
      )
    )
);
