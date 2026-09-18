import { type Context, Effect } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import {
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/**
 * Authenticate each request and provide its identity to the downstream handler.
 * `authenticate` fails with the response to send instead, so the host owns its
 * status, body and challenge headers. Dependencies remain native router request
 * requirements. Acquired resources live until the request scope closes, including
 * while the handler is running. Every response is marked `Cache-Control: no-store`.
 */
export const middleware = <I, A, R>(
  service: Context.Key<I, A>,
  authenticate: Effect.Effect<NoInfer<A>, HttpServerResponse.HttpServerResponse, R>,
) =>
  HttpRouter.middleware<{ provides: I }>()((httpEffect) =>
    authenticate.pipe(
      Effect.matchEffect({
        onFailure: Effect.succeed,
        onSuccess: (identity) => Effect.provideService(httpEffect, service, identity),
      }),
      HttpEffect.withPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
      ),
    ),
  );

/** RFC 9728 metadata to publish; the host is responsible for these being valid OAuth URLs. */
export interface ProtectedResourceOptions {
  /** Exact OAuth resource identifier; its path and query select the discovery path. */
  readonly resource: string;
  readonly authorizationServers: NonEmptyReadonlyArray<string>;
  readonly scopesSupported?: ReadonlyArray<string>;
  readonly resourceName?: string;
}

/** Parameters of one `WWW-Authenticate: Bearer` challenge, RFC 6750 §3. */
export interface BearerChallengeOptions {
  readonly error?: "invalid_token" | "insufficient_scope";
  readonly errorDescription?: string;
  /** Space-separated scopes needed for this request, not all supported scopes. */
  readonly scope?: string;
}

const quoted = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

/**
 * Publish RFC 9728 discovery independently from the authenticated routes.
 * This supplies metadata and challenges; the host still verifies access tokens.
 */
export const protectedResource = (options: ProtectedResourceOptions) => {
  const resource = new URL(options.resource);

  const path =
    `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}` as const;

  const discoveryUrl = new URL(resource);
  discoveryUrl.pathname = path;
  const metadataUrl = discoveryUrl.href;
  const target = metadataUrl.slice(discoveryUrl.origin.length);

  // `undefined` fields are dropped by JSON serialization.
  const response = HttpServerResponse.jsonUnsafe({
    resource: options.resource,
    authorization_servers: options.authorizationServers,
    bearer_methods_supported: ["header"],
    scopes_supported: options.scopesSupported,
    resource_name: options.resourceName,
  });

  return {
    // Resource paths and queries are literal URLs, not router patterns. Leave nonmatches
    // to the host, including other discovery documents on the same router.
    layer: HttpRouter.middleware(
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
    ),
    metadataUrl,
    /** The `WWW-Authenticate` value; parameter values are quoted and escaped. */
    challenge: (challenge: BearerChallengeOptions = {}): string => {
      const parameters = [
        ["resource_metadata", metadataUrl],
        ["error", challenge.error],
        ["error_description", challenge.errorDescription],
        ["scope", challenge.scope],
      ] as const;

      return `Bearer ${parameters
        .flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${quoted(value)}`]))
        .join(", ")}`;
    },
  };
};
