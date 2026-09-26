import { type Context, Effect, Option } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import {
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type { Refusal } from "./internal/errors.js";
import { refuse } from "./internal/respond.js";

/**
 * The bearer token of the request's `Authorization` header, if it has one. The scheme
 * is matched case-insensitively, as RFC 9110 requires.
 */
export const bearerToken: Effect.Effect<
  Option.Option<string>,
  never,
  HttpServerRequest.HttpServerRequest
> = Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
  const match = /^Bearer +(\S+) *$/i.exec(request.headers.authorization ?? "");

  return Option.fromNullishOr(match?.[1]);
});

/**
 * Authenticate each request and provide its identity to the downstream handler.
 * `authenticate` fails with `Unauthenticated` (a 401 with a `Bearer` challenge) or
 * `Forbidden` (a 403), each sent as the JSON every client decodes, or with the response
 * to send instead. Dependencies remain native router request requirements. Acquired
 * resources live until the request scope closes, including while the handler is running.
 * Every response is marked `Cache-Control: no-store`, including private failures
 * serialized by enclosing middleware.
 */
export const middleware = <I, A, R>(
  service: Context.Key<I, A>,
  authenticate: Effect.Effect<NoInfer<A>, HttpServerResponse.HttpServerResponse | Refusal, R>,
) => router<I, R>(service, authenticate);

const router = <I, R>(
  service: Context.Key<I, unknown>,
  authenticate: Effect.Effect<unknown, HttpServerResponse.HttpServerResponse | Refusal, R>,
) =>
  HttpRouter.middleware<{ provides: I }>()((httpEffect) =>
    authenticate.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          HttpServerResponse.isHttpServerResponse(error) ? Effect.succeed(error) : refuse(error),
        onSuccess: (identity) => Effect.provideService(httpEffect, service, identity),
      }),
      HttpEffect.withPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
      ),
    ),
  );

/** RFC 9728 metadata to publish; the host is responsible for these being valid OAuth URLs. */
interface ProtectedResourceOptions {
  /** Exact OAuth resource identifier; its path and query select the discovery path. */
  readonly resource: string;
  readonly authorizationServers: NonEmptyReadonlyArray<string>;
  readonly scopesSupported?: ReadonlyArray<string>;
  readonly resourceName?: string;
}

/**
 * Publish RFC 9728 discovery at `/.well-known/oauth-protected-resource` followed by the
 * resource's path, where MCP clients look when a 401 names no metadata URL. Serve it
 * independently from the authenticated routes; the host still verifies access tokens.
 */
export const protectedResource = (options: ProtectedResourceOptions) => {
  const resource = new URL(options.resource);

  const discoveryUrl = new URL(resource);
  discoveryUrl.pathname = `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`;
  const target = discoveryUrl.href.slice(discoveryUrl.origin.length);

  // `undefined` fields are dropped by JSON serialization.
  const response = HttpServerResponse.jsonUnsafe({
    resource: options.resource,
    authorization_servers: options.authorizationServers,
    bearer_methods_supported: ["header"],
    scopes_supported: options.scopesSupported,
    resource_name: options.resourceName,
  });

  // Resource paths and queries are literal URLs, not router patterns. Leave nonmatches
  // to the host, including other discovery documents on the same router.
  return HttpRouter.middleware(
    (next) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, resource.origin);

        if (
          (request.method === "GET" || request.method === "HEAD") &&
          url.href.slice(url.origin.length) === target
        )
          return response;

        return yield* next;
      }),
    { global: true },
  );
};
