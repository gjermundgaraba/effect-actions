import { type Context, Effect, Schema, SchemaAST } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import {
  type Headers,
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type * as Action from "./Action.js";

export interface Options<A, Errors extends ReadonlyArray<Action.Codec>, R> {
  readonly authenticate: Effect.Effect<A, Errors[number]["Type"], R>;
  readonly errors: Errors;
  readonly headers?: (error: Errors[number]["Type"]) => Headers.Input;
}

/**
 * Authenticate each request and provide its identity to the downstream handler.
 * Only authentication failures are encoded, using each schema's httpApiStatus.
 * Dependencies remain native router request requirements. Acquired resources live
 * until the request scope closes, including while the handler is running.
 */
export const middleware = <I, A, const Errors extends ReadonlyArray<Action.Codec>, R>(
  service: Context.Key<I, A>,
  options: Options<NoInfer<A>, Errors, R>,
) => {
  const errors = options.errors.map((schema) => ({
    matches: Schema.is(schema),
    encode: HttpServerResponse.schemaJson(schema),
    status: SchemaAST.resolveAt<number>("httpApiStatus")(schema.ast) ?? 500,
  }));

  return HttpRouter.middleware<{ provides: I }>()((httpEffect) =>
    options.authenticate.pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const selected = errors.find((candidate) => candidate.matches(error));

          if (selected === undefined)
            return Effect.die(new Error("Undeclared authentication error"));

          return selected
            .encode(error, {
              status: selected.status,
              headers: options.headers?.(error),
            })
            .pipe(Effect.orDie);
        },
        onSuccess: (identity) => Effect.provideService(httpEffect, service, identity),
      }),
      HttpEffect.withPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
      ),
    ),
  );
};

export interface ProtectedResourceOptions {
  /** Exact OAuth resource identifier. HTTPS, or HTTP on loopback for development. */
  readonly resource: string;
  readonly authorizationServers: NonEmptyReadonlyArray<string>;
  readonly scopesSupported?: ReadonlyArray<string>;
  readonly resourceName?: string;
}

export interface BearerChallengeOptions {
  readonly error?: "invalid_token" | "insufficient_scope";
  readonly errorDescription?: string;
  /** Space-separated scopes needed for this request, not all supported scopes. */
  readonly scope?: string;
}

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: NonEmptyReadonlyArray<string>;
  bearer_methods_supported: ReadonlyArray<string>;
  scopes_supported?: ReadonlyArray<string>;
  resource_name?: string;
}

const oauthUrl = (value: string): URL => {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    value.includes("#")
  ) {
    throw new Error("OAuth URLs must use HTTPS (or loopback HTTP) without credentials or fragment");
  }

  return url;
};

const scopeToken = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * Publish RFC 9728 discovery independently from the authenticated routes.
 * This supplies metadata and challenges; the host still verifies access tokens.
 */
export const protectedResource = (options: ProtectedResourceOptions) => {
  const resource = oauthUrl(options.resource);

  if (options.authorizationServers.length === 0)
    throw new Error("An authorization server is required");

  for (const issuer of options.authorizationServers) {
    oauthUrl(issuer);

    if (issuer.includes("?"))
      throw new Error("Authorization server issuers must not contain a query");
  }

  for (const scope of options.scopesSupported ?? []) {
    if (!scopeToken.test(scope)) throw new Error("Invalid OAuth scope token");
  }

  const path =
    `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}` as const;

  const discoveryUrl = new URL(resource);
  discoveryUrl.pathname = path;
  const metadataUrl = discoveryUrl.href;
  const target = metadataUrl.slice(discoveryUrl.origin.length);

  const metadata: ProtectedResourceMetadata = {
    resource: options.resource,
    authorization_servers: options.authorizationServers,
    bearer_methods_supported: ["header"],
  };

  if (options.scopesSupported !== undefined && options.scopesSupported.length > 0) {
    metadata.scopes_supported = options.scopesSupported;
  }

  if (options.resourceName !== undefined) metadata.resource_name = options.resourceName;

  const response = HttpServerResponse.jsonUnsafe(metadata);

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
    challenge: (challenge: BearerChallengeOptions = {}): string => {
      const parameters = [`resource_metadata="${metadataUrl.replace(/["\\]/g, "\\$&")}"`];

      if (challenge.error !== undefined) parameters.push(`error="${challenge.error}"`);

      if (challenge.errorDescription !== undefined) {
        if (!/^[\x20-\x21\x23-\x5B\x5D-\x7E]*$/.test(challenge.errorDescription)) {
          throw new Error("Invalid OAuth error description");
        }

        parameters.push(`error_description="${challenge.errorDescription}"`);
      }

      if (challenge.scope !== undefined) {
        if (!challenge.scope.split(" ").every((scope) => scopeToken.test(scope))) {
          throw new Error("Invalid OAuth challenge scope");
        }

        parameters.push(`scope="${challenge.scope}"`);
      }

      return `Bearer ${parameters.join(", ")}`;
    },
  };
};
