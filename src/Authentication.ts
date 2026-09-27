import { type Context, Effect, Layer } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import {
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { type Refusal, Unauthenticated } from "./internal/errors.js";
import { bearer, refuse, ResourceMetadata } from "./internal/refusal.js";

/**
 * The bearer token of the request's `Authorization` header, failing with `Unauthenticated`
 * when it has none. The scheme is matched case-insensitively, as RFC 9110 requires. Where
 * a token is optional, `Effect.option(bearerToken)`.
 */
export const bearerToken: Effect.Effect<
  string,
  Unauthenticated,
  HttpServerRequest.HttpServerRequest
> = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
  const token = /^Bearer +(\S+) *$/i.exec(request.headers.authorization ?? "")?.[1];

  return token === undefined
    ? Effect.fail(new Unauthenticated({ message: "A bearer token is required." }))
    : Effect.succeed(token);
});

/** An OAuth protected resource (RFC 9728), as `make` publishes it. */
export interface Options {
  /** Exact OAuth resource identifier; its path and query select the discovery path. */
  readonly resource: string;
  /** Where clients get tokens: nonempty. */
  readonly authorizationServers: NonEmptyReadonlyArray<string>;
  /** Every scope the resource accepts, which a client requests when a 401 names none. */
  readonly scopesSupported?: ReadonlyArray<string>;
  readonly resourceName?: string;
}

/**
 * RFC 9728 discovery of `options` at `/.well-known/oauth-protected-resource` followed by the
 * resource's path, where MCP clients look when a 401 names no metadata URL, and that URL. It
 * answers before routing, so no route middleware, authentication included, ever covers it.
 */
const discovery = (options: Options) => {
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
  const layer = HttpRouter.middleware(
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
 * Every response of the routes it covers is marked `Cache-Control: no-store`, and every
 * 401 among them without a challenge gets one, including failures serialized by enclosing
 * middleware: `Bearer`. Given an OAuth protected resource, it also publishes the resource's
 * RFC 9728 discovery, once however many layers it covers, public and before routing, and
 * every challenge names its metadata URL, a 401's and the `insufficient_scope` challenge of a
 * refusal naming scopes.
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
  const published = protectedResource === undefined ? undefined : discovery(protectedResource);

  // No error code: RFC 6750 §3.1 makes one optional, and a client re-authenticates on any 401.
  const challenge = bearer([["resource_metadata", published?.url]]);

  // SAFETY: native middleware types its layer only once no request requirement is left,
  // asking for another middleware to provide them. The layer is the same at run time, and
  // they stay requirements of the routes it covers, as the type states.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native middleware boundary.
  const middleware = HttpRouter.middleware<{ provides: I }>()((httpEffect) =>
    authenticate.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          HttpServerResponse.isHttpServerResponse(error) ? Effect.succeed(error) : refuse(error),
        onSuccess: (identity) => Effect.provideService(httpEffect, service, identity),
      }),
      // Every refusal under it, its own, a hook's or a handler's, names the metadata URL.
      (answered) =>
        published === undefined
          ? answered
          : Effect.provideService(answered, ResourceMetadata, published.url),
      HttpEffect.withPreResponseHandler((_request, response) =>
        Effect.succeed(
          HttpServerResponse.setHeaders(response, {
            "cache-control": "no-store",
            ...(response.status === 401 && response.headers["www-authenticate"] === undefined
              ? { "www-authenticate": challenge }
              : {}),
          }),
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
