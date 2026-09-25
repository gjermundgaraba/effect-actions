import { type Context, Effect, Option, Predicate, Schema, SchemaAST } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import {
  type Headers,
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type * as Action from "./Action.js";

/** How `middleware` answers a refusal it declares. */
export interface MiddlewareOptions<Errors extends ReadonlyArray<Action.Codec>> {
  /**
   * The errors `authenticate` may fail with besides a response: each is sent as its JSON
   * encoding with its `httpApiStatus` (500 without one). Pass the binding's `Http.errors`,
   * so what clients decode and what is sent are declared once.
   */
  readonly errors?: Errors;
  /**
   * Headers of such an answer, such as `{ "www-authenticate": "Bearer" }`, or a function
   * of the error, so a challenge goes only with the refusals that need it.
   */
  readonly headers?: Headers.Input | ((error: Errors[number]["Type"]) => Headers.Input);
}

const statusOf = SchemaAST.resolveAt<number>("httpApiStatus");

/**
 * The response to a declared refusal. It was declared, so it encodes; an encoding
 * failure is a defect.
 */
const respond =
  (options: MiddlewareOptions<ReadonlyArray<Action.Codec>>) =>
  <E>(error: E): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
    const schema = options.errors?.find((candidate) => Schema.is(candidate)(error));

    if (schema === undefined) return Effect.die(error);

    const headers = Predicate.isFunction(options.headers)
      ? options.headers(error)
      : options.headers;

    return HttpServerResponse.schemaJson(schema)(error, {
      status: statusOf(schema.ast) ?? 500,
      ...(headers === undefined ? {} : { headers }),
    }).pipe(Effect.orDie);
  };

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
 * `authenticate` fails with a declared error from `options.errors`, answered as JSON
 * with its status, or with the response to send instead. Dependencies remain native
 * router request requirements. Acquired resources live until the request scope closes,
 * including while the handler is running. Every response is marked
 * `Cache-Control: no-store`, including private failures serialized by enclosing
 * middleware.
 */
export function middleware<I, A, R, const Errors extends ReadonlyArray<Action.Codec> = []>(
  service: Context.Key<I, A>,
  authenticate: Effect.Effect<
    NoInfer<A>,
    HttpServerResponse.HttpServerResponse | NoInfer<Errors[number]["Type"]>,
    R
  >,
  options?: MiddlewareOptions<Errors>,
): ReturnType<typeof router<I, R>>;
export function middleware<I, A, R, E>(
  service: Context.Key<I, A>,
  authenticate: Effect.Effect<A, E, R>,
  options: MiddlewareOptions<ReadonlyArray<Action.Codec>> = {},
) {
  return router<I, R, E>(service, authenticate, respond(options));
}

const router = <I, R, E = never>(
  service: Context.Key<I, unknown>,
  authenticate: Effect.Effect<unknown, E, R>,
  refuse: (error: E) => Effect.Effect<HttpServerResponse.HttpServerResponse>,
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
