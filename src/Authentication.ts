import { type Array as Arr, type Context, Effect, Redacted, type Scope } from "effect";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { type Refusal, scopeToken, Unauthenticated } from "./internal/errors.js";
import { answer, answerStepUp, bearer } from "./internal/refusal.js";

/** An `Authorization` header of the `Bearer` scheme, and its token. */
const bearerScheme = /^Bearer +(\S+) *$/i;

/**
 * The bearer token of the request's `Authorization` header, failing with `Unauthenticated`
 * when it has none. The scheme is matched case-insensitively, as RFC 9110 requires. The
 * token is `Redacted`, as Effect's own `HttpApiSecurity.bearer` gives it, so a log or an
 * error holding it never prints it; `Redacted.value(token)` reads it. Where a token is
 * optional, `Effect.option(bearerToken)`.
 */
export const bearerToken: Effect.Effect<
  Redacted.Redacted<string>,
  Unauthenticated,
  HttpServerRequest.HttpServerRequest
> = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
  const token = bearerScheme.exec(request.headers.authorization ?? "")?.[1];

  return token === undefined
    ? Effect.fail(new Unauthenticated({ message: "A bearer token is required." }))
    : Effect.succeed(Redacted.make(token));
});

/** An OAuth protected resource (RFC 9728), as `make` publishes it. */
export interface Options {
  /** Exact OAuth resource identifier; its path and query select the discovery path. */
  readonly resource: string;
  /** Where clients get tokens: nonempty. */
  readonly authorizationServers: Arr.NonEmptyReadonlyArray<string>;
  /** Every scope the resource accepts, which a client requests when a 401 names none. */
  readonly scopesSupported?: ReadonlyArray<string>;
  /**
   * The scopes every 401 names, each an OAuth scope token: what a client requests when it
   * authenticates, rather than every scope supported. A `Forbidden` naming scopes asks for
   * more when a call needs them.
   */
  readonly scopesRequired?: Arr.NonEmptyReadonlyArray<string>;
  readonly resourceName?: string;
}

/**
 * The RFC 9728 metadata URL of `options`: `/.well-known/oauth-protected-resource` followed
 * by the resource's path, where MCP clients look when a 401 names no metadata URL.
 */
const metadataUrl = (options: Options): URL => {
  const resource = new URL(options.resource);
  const url = new URL(resource);
  url.pathname = `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`;

  return url;
};

/**
 * The challenge of every 401 about `options`: `Bearer`, naming the scopes a client requests
 * and the metadata URL where it finds its authorization server. A request that presented
 * credentials is told they are invalid, RFC 6750's `invalid_token`, on which a client may
 * refresh its token before it signs in again; one that presented none names no error code.
 */
const challengeOf = (options: Options | undefined, presented: boolean): string =>
  bearer([
    ["error", presented ? "invalid_token" : undefined],
    ["scope", options?.scopesRequired?.join(" ")],
    ["resource_metadata", options === undefined ? undefined : metadataUrl(options).href],
  ]);

/** Refuse a `scopesRequired` that is no list of OAuth scope tokens, as `Forbidden` does. */
const assertScopes = (options: Options | undefined): void => {
  const invalid = options?.scopesRequired?.find((scope) => !scopeToken.test(scope));

  if (invalid !== undefined) throw new Error(`Invalid scope in scopesRequired: "${invalid}"`);
};

/**
 * `response` as the routes of the authentication answer: `no-store` unless it states its
 * own caching, and a 401 challenged with `challenge` unless it names its own.
 */
const settle = (
  response: HttpServerResponse.HttpServerResponse,
  challenge: string,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeaders(response, {
    ...(response.headers["cache-control"] === undefined ? { "cache-control": "no-store" } : {}),
    ...(response.status === 401 && response.headers["www-authenticate"] === undefined
      ? { "www-authenticate": challenge }
      : {}),
  });

/**
 * RFC 9728 discovery of `options` at its metadata URL, as global router middleware: it
 * answers before routing, so no route middleware, authentication included, ever covers it.
 * The metadata is public to every origin, as a browser client needs it after a 401: it
 * carries `Access-Control-Allow-Origin: *`, and discovery answers its own CORS preflight.
 * Where the host's CORS middleware runs before it, that policy answers the preflight and
 * adds its headers to reads, which keep the `*` where it sets no origin.
 */
const discovery = (options: Options) => {
  const discoveryUrl = metadataUrl(options);
  const target = discoveryUrl.href.slice(discoveryUrl.origin.length);

  // `undefined` fields are dropped by JSON serialization.
  const metadata = HttpServerResponse.jsonUnsafe(
    {
      resource: options.resource,
      authorization_servers: options.authorizationServers,
      bearer_methods_supported: ["header"],
      scopes_supported: options.scopesSupported,
      resource_name: options.resourceName,
    },
    { headers: { "access-control-allow-origin": "*" } },
  );

  /** The preflight of a cross-origin read, allowing the headers it asks for. */
  const preflight = (request: HttpServerRequest.HttpServerRequest) => {
    const requested = request.headers["access-control-request-headers"];

    return HttpServerResponse.empty({
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        ...(requested === undefined
          ? {}
          : { "access-control-allow-headers": requested, vary: "Access-Control-Request-Headers" }),
      },
    });
  };

  // Resource paths and queries are literal URLs, not router patterns. Leave nonmatches
  // to the host, including other discovery documents on the same router.
  const middleware = <E, R>(next: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      // A request no URL parses, such as `//[x`, is no discovery request: the host answers it.
      const targeted =
        URL.canParse(request.url, discoveryUrl.origin) &&
        new URL(request.url, discoveryUrl.origin).href.slice(discoveryUrl.origin.length) === target;

      if (targeted && (request.method === "GET" || request.method === "HEAD"))
        return Effect.succeed(metadata);

      if (targeted && request.method === "OPTIONS") return Effect.succeed(preflight(request));

      return next;
    });

  return { url: discoveryUrl.href, middleware };
};

/**
 * How a remote caller proves who they are: Effect's router middleware, which authenticates
 * each request and provides its identity to the routes it covers. Provide its `.layer` to the
 * HTTP surfaces serving guarded implementations, `ActionHttp.layer` and
 * `ActionMcp.layerHttp`, as to any native route: it covers the routes of the layer it is
 * provided to, before decoding, and removes the identity from that layer's request
 * requirements.
 *
 * `build` is a builder, like the one `Action.implement` takes: an Effect yielding startup
 * services, such as a token verifier, that returns the per-request authentication. It runs
 * once per layer graph, when the middleware's layer is built, and what it yields that layer
 * requires. The per-request authentication succeeds with the identity, or fails with
 * `Unauthenticated` (a 401) or `Forbidden` (a 403), each sent as the JSON every client
 * decodes, or with the response to send instead. It reads the request the router provides;
 * another service it reads per request comes from middleware combined before it,
 * `authentication.combine(resolveTenant)`, and middleware reading the identity combines after
 * it, `accessLog.combine(authentication)`. Resources it acquires live until the request scope
 * closes, including while the handler is running.
 *
 * Every response of the routes it covers is marked `Cache-Control: no-store`, unless its
 * route states its own caching, and a failure serialized by enclosing middleware always is.
 * Every 401 among them without a challenge gets one: `Bearer`, naming `invalid_token` when
 * the request presented a bearer token. A call under it refused with `Unauthenticated`, or
 * with a `Forbidden` naming scopes, by a hook or a handler, is answered with that refusal's
 * status, JSON and challenge, whatever its route answered, as OAuth step-up and MCP
 * authorization require. Given an OAuth protected resource, building it also publishes the
 * resource's RFC 9728 discovery, once per layer graph whatever composition builds it, public
 * and before routing; every challenge names its metadata URL, and a 401's names
 * `scopesRequired`.
 */
export const make = <I, A, R, EX, RX>(
  service: Context.Key<I, A>,
  build: Effect.Effect<
    Effect.Effect<NoInfer<A>, HttpServerResponse.HttpServerResponse | Refusal, R>,
    EX,
    RX
  >,
  protectedResource?: Options,
): HttpRouter.Middleware<{
  provides: I;
  handles: never;
  error: never;
  requires: Exclude<R, HttpRouter.Provided>;
  layerError: EX;
  layerRequires: HttpRouter.HttpRouter | Exclude<RX, Scope.Scope>;
}> => {
  assertScopes(protectedResource);

  const published = protectedResource === undefined ? undefined : discovery(protectedResource);
  const anonymous = challengeOf(protectedResource, false);
  const presented = challengeOf(protectedResource, true);

  // A response made of a covered route's failure elsewhere, such as by enclosing middleware,
  // may carry what the route failed with, whatever caching it states.
  const failed = HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
  );

  return HttpRouter.middleware<{ provides: I }>()(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;

      // Published where the middleware is built, so every composition of it publishes it.
      if (published !== undefined) yield* router.addGlobalMiddleware(published.middleware);

      const authenticate = yield* build;

      return (route) =>
        authenticate.pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.succeed(
                HttpServerResponse.isHttpServerResponse(error)
                  ? error
                  : answer(error, published?.url),
              ),
            onSuccess: (identity) =>
              answerStepUp(Effect.provideService(route, service, identity), published?.url).pipe(
                Effect.onError(() => failed),
              ),
          }),
          HttpEffect.withPreResponseHandler((request, response) =>
            Effect.succeed(
              settle(
                response,
                bearerScheme.test(request.headers.authorization ?? "") ? presented : anonymous,
              ),
            ),
          ),
        );
    }),
  );
};
