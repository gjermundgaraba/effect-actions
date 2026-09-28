import { type Context, Effect, Layer, Redacted } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { type Refusal, scopeToken, Unauthenticated } from "./internal/errors.js";
import { answer, bearer, ResourceMetadata } from "./internal/refusal.js";

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
  const token = /^Bearer +(\S+) *$/i.exec(request.headers.authorization ?? "")?.[1];

  return token === undefined
    ? Effect.fail(new Unauthenticated({ message: "A bearer token is required." }))
    : Effect.succeed(Redacted.make(token));
});

/** An OAuth protected resource (RFC 9728), as `make` publishes it. */
export interface Options {
  /** Exact OAuth resource identifier; its path and query select the discovery path. */
  readonly resource: string;
  /** Where clients get tokens: nonempty. */
  readonly authorizationServers: NonEmptyReadonlyArray<string>;
  /** Every scope the resource accepts, which a client requests when a 401 names none. */
  readonly scopesSupported?: ReadonlyArray<string>;
  /**
   * The scopes every 401 names, each an OAuth scope token: what a client requests when it
   * authenticates, rather than every scope supported. A `Forbidden` naming scopes asks for
   * more when a call needs them.
   */
  readonly scopesRequired?: NonEmptyReadonlyArray<string>;
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
 * RFC 9728 discovery of `options` at its metadata URL. It answers before routing, so no
 * route middleware, authentication included, ever covers it.
 */
const discovery = (options: Options) => {
  const discoveryUrl = metadataUrl(options);
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
  const layer = HttpRouter.middleware(
    (next) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, discoveryUrl.origin);

        if (
          (request.method === "GET" || request.method === "HEAD") &&
          url.href.slice(url.origin.length) === target
        )
          return response;

        return yield* next;
      }),
    { global: true },
  );

  return { url: discoveryUrl.href, layer };
};

/**
 * How a remote caller proves who they are: router middleware that authenticates each
 * request and provides its identity to the handler. Provide it to the HTTP surfaces
 * serving guarded implementations, `ActionHttp.layer` and `ActionMcp.layerHttp`, as to
 * any native route: it covers the routes of the layer it is provided to, before decoding,
 * and removes the identity from that layer's request requirements.
 *
 * `authenticate` fails with `Unauthenticated` (a 401) or `Forbidden` (a 403), each sent as
 * the JSON every client decodes, or with the response to send instead. The services it
 * yields are request requirements, like a handler's, which the layer keeps;
 * `HttpRouter.provideRequest` builds one once, such as a token verifier. Acquired
 * resources live until the request scope closes, including while the handler is running.
 *
 * Every response of the routes it covers is marked `Cache-Control: no-store`, unless its
 * route states its own caching, and a failure serialized by enclosing middleware always is.
 * Every 401 among them without a challenge gets one: `Bearer`, naming `invalid_token` when
 * the request presented credentials. Given an OAuth protected
 * resource, it also publishes the resource's RFC 9728 discovery, once however many layers it
 * covers, public and before routing; every challenge names its metadata URL, a 401's and the
 * `insufficient_scope` challenge of a refusal naming scopes, and a 401's names
 * `scopesRequired`.
 */
export const make = <I, A, R>(
  service: Context.Key<I, A>,
  authenticate: Effect.Effect<NoInfer<A>, HttpServerResponse.HttpServerResponse | Refusal, R>,
  protectedResource?: Options,
): Layer.Layer<
  HttpRouter.Request.From<"Requires", I>,
  never,
  HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", Exclude<R, HttpRouter.Provided>>
> => {
  assertScopes(protectedResource);

  const published = protectedResource === undefined ? undefined : discovery(protectedResource);
  const anonymous = challengeOf(protectedResource, false);
  const presented = challengeOf(protectedResource, true);

  // A response made of a covered route's failure elsewhere, such as by enclosing middleware,
  // may carry what the route failed with, whatever caching it states.
  const failed = HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
  );

  // SAFETY: native middleware types its layer only once no request requirement is left,
  // asking for another middleware to provide them. The layer is the same at run time, and
  // they stay requirements of the routes it covers, as the type states.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native middleware boundary.
  const middleware = HttpRouter.middleware<{ provides: I }>()((httpEffect) =>
    authenticate.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed(
            HttpServerResponse.isHttpServerResponse(error) ? error : answer(error, published?.url),
          ),
        onSuccess: (identity) =>
          Effect.provideService(httpEffect, service, identity).pipe(Effect.onError(() => failed)),
      }),
      // Every refusal under it, its own, a hook's or a handler's, names the metadata URL.
      (answered) =>
        published === undefined
          ? answered
          : Effect.provideService(answered, ResourceMetadata, published.url),
      HttpEffect.withPreResponseHandler((request, response) =>
        Effect.succeed(
          settle(response, request.headers.authorization === undefined ? anonymous : presented),
        ),
      ),
    ),
  ).layer as Layer.Layer<
    HttpRouter.Request.From<"Requires", I>,
    never,
    HttpRouter.Request.From<"Requires", Exclude<R, HttpRouter.Provided>>
  >;

  return published === undefined ? middleware : Layer.merge(middleware, published.layer);
};

/**
 * The response `make` answers `error` with, for a caller outside the router, such as a
 * WebSocket upgrade refused before any route: its JSON with its status, `no-store`, and the
 * challenge of a 401, or of a `Forbidden` naming scopes, naming `protectedResource`'s
 * metadata URL. `authorization` is the request's `Authorization` header, when it has one: a
 * 401 then names `invalid_token`, as `make` does. `HttpServerResponse.toWeb` makes it a web
 * `Response`.
 */
export const refusal = (
  error: Refusal,
  protectedResource?: Options,
  authorization?: string,
): HttpServerResponse.HttpServerResponse => {
  assertScopes(protectedResource);

  return settle(
    answer(
      error,
      protectedResource === undefined ? undefined : metadataUrl(protectedResource).href,
    ),
    challengeOf(protectedResource, authorization !== undefined),
  );
};
