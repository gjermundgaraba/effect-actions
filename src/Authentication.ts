import {
  type Array as Arr,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  type Scope,
} from "effect";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import {
  type Any,
  type Credential,
  type Descriptor,
  type Provider,
  type Runtime,
  type Security,
  type SecurityMiddleware,
} from "./internal/authentication.js";
import { type Refusal, scopeToken, Unauthenticated } from "./internal/errors.js";
import type { Known, OptionalUnless } from "./internal/implementation.js";
import { answer, answerStepUp, bearer, challenge, isStepUp, plain } from "./internal/refusal.js";

/**
 * An `Authorization` header of the `Bearer` scheme, and its token, as Effect's own
 * `HttpApiSecurity.bearer` decodes a request's: the scheme, matched case-insensitively, one or
 * more spaces, then the rest of the header, whatever it holds. The whitespace around a header
 * value is no part of it, and an HTTP parser strips it before any route reads it.
 */
const bearerScheme = /^[ \t]*Bearer +([^ \t](?:.*[^ \t])?)[ \t]*$/i;

/**
 * The bearer token of an `Authorization` header, `authorization`, or none: the one reading
 * of the header, which `bearerToken`, every challenge and a Bearer descriptor's verifier
 * share, as Effect's `HttpApiSecurity.bearer` reads it. It is for a caller the router never
 * routes, which holds the header and no request. The scheme is matched case-insensitively,
 * as RFC 9110 requires, and the token is `Redacted`, as `bearerToken`'s.
 */
export const bearerTokenOf = (
  authorization: string | undefined,
): Option.Option<Redacted.Redacted<string>> =>
  Option.map(
    Option.fromNullishOr(bearerScheme.exec(authorization ?? "")?.[1]),
    (token): Redacted.Redacted<string> => Redacted.make(token),
  );

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
> = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
  Option.match(bearerTokenOf(request.headers.authorization), {
    onNone: () => Effect.fail(new Unauthenticated({ message: "A bearer token is required." })),
    onSome: Effect.succeed,
  }),
);

/** An OAuth protected resource (RFC 9728), as `layer` publishes it. */
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

/** What a resource's challenges name: its scopes checked, and its metadata URL. */
interface Named {
  readonly scope: string | undefined;
  readonly metadataUrl: string | undefined;
}

/** What challenges about `options` name, refusing a `scopesRequired` that is no scope token. */
const namedOf = (options: Options | undefined): Named => {
  assertScopes(options);

  return {
    scope: options?.scopesRequired?.join(" "),
    metadataUrl: options === undefined ? undefined : metadataUrl(options).href,
  };
};

/** Whether a request whose `Authorization` header is `authorization` presented a bearer token. */
const tokenPresented = (authorization: string | undefined): boolean =>
  Option.isSome(bearerTokenOf(authorization));

/**
 * The challenge of a 401: `Bearer`, naming the scopes a client requests and the metadata URL
 * where it finds its authorization server. A request that presented a bearer token is told
 * it is invalid, RFC 6750's `invalid_token`, on which a client may refresh its token before
 * it signs in again; one that presented none names no error code.
 */
const challengeOf = (named: Named, presented: boolean): string =>
  bearer([
    ["error", presented ? "invalid_token" : undefined],
    ["scope", named.scope],
    ["resource_metadata", named.metadataUrl],
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
  challenge: string | undefined,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeaders(response, {
    ...(response.headers["cache-control"] === undefined ? { "cache-control": "no-store" } : {}),
    ...(challenge !== undefined &&
    response.status === 401 &&
    response.headers["www-authenticate"] === undefined
      ? { "www-authenticate": challenge }
      : {}),
  });

/** What `refusal` answers about. */
export interface RefusalOptions {
  /**
   * The descriptor refusing, whose scheme decides the challenge: Bearer's, below, when left
   * out; another scheme's 401 names that scheme, and nothing steps up under it.
   */
  readonly authentication?: Any | undefined;
  /** The OAuth protected resource refusing: the one given to `layer`. */
  readonly protectedResource?: Options | undefined;
  /** The request's `Authorization` header, which decides whether a 401 names `invalid_token`. */
  readonly authorization?: string | undefined;
}

/**
 * The response `layer` answers a refusal with, for a caller the router never routes, such as
 * a Node `upgrade` handler admitting a socket: its status, its JSON, `Cache-Control: no-store`
 * and its challenge, an `Unauthenticated`'s `Bearer`, naming `invalid_token` when
 * `authorization` presented a bearer token, or the `insufficient_scope` of a `Forbidden`
 * naming scopes. Given the protected resource `layer` was, every challenge names its metadata
 * URL and a 401's its `scopesRequired`. Under a descriptor of another scheme, it is the JSON
 * and status alone, a 401 naming that scheme. `HttpServerResponse.toWeb` gives it as a web
 * `Response`.
 */
export const refusal = (
  error: Refusal,
  options?: RefusalOptions,
): HttpServerResponse.HttpServerResponse => {
  const authentication = options?.authentication;

  if (authentication !== undefined && !isBearer(authentication.security)) {
    return settle(plain(error), schemeChallenge(authentication.security, authentication.name));
  }

  const named = namedOf(options?.protectedResource);

  return settle(
    answer(error, named.metadataUrl),
    challengeOf(named, tokenPresented(options?.authorization)),
  );
};

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
  return <E, R>(next: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
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
};

/**
 * What `layer` answers about the protected resource `options`, written once: its metadata
 * URL, each 401's challenge, to a request that presented a bearer token and to one that did
 * not, and its discovery, none without a resource.
 */
const answersOf = (options: Options | undefined) => {
  const named = namedOf(options);

  return {
    metadataUrl: named.metadataUrl,
    invalid: challengeOf(named, true),
    anonymous: challengeOf(named, false),
    published: options === undefined ? undefined : discovery(options),
  };
};

/** Whether `security` is the Bearer scheme, the one OAuth challenges and discovery name. */
const isBearer = (security: Security): boolean =>
  Predicate.isTagged(security, "Http") && security.scheme.toLowerCase() === "bearer";

/** What an OpenAPI component key may hold, and so a descriptor's name, which is its key. */
const componentKey = /^[\w.-]+$/;

/**
 * The challenge of a 401 under a scheme other than Bearer: the scheme an `Http` one names,
 * Basic with its realm, the descriptor's name; an API key has no scheme to name.
 */
const schemeChallenge = (security: Security, name: string): string | undefined =>
  Match.value(security).pipe(
    Match.tag("Http", ({ scheme }) => challenge(scheme, [])),
    Match.tag("Basic", () => challenge("Basic", [["realm", name]])),
    Match.tag("ApiKey", () => undefined),
    Match.exhaustive,
  );

/** What `make` takes besides the name and the identity. */
export interface MakeOptions {
  /** The one native scheme a caller proves the identity by: Bearer when left out. */
  readonly security?: Security;
}

/** The scheme options `O` give: Bearer too wherever they may leave it out, as at run time. */
type SecurityOf<O> = O extends { readonly security: infer S extends Security }
  ? S
  : "security" extends keyof O
    ? NonNullable<O["security" & keyof O]> | HttpApiSecurity.Http
    : HttpApiSecurity.Http;

/**
 * Browser-safe declaration shared by clients and remote surfaces: the identity `service` it
 * authenticates, by the one native scheme `security`, Bearer unless it names another, such
 * as `HttpApiSecurity.apiKey({ in: "cookie", key: "session" })`. The literal name is the
 * provider identity, like a native Context.Key name, and the scheme's OpenAPI key, so it
 * holds only letters, digits, `_`, `.` and `-`; reuse one name only for one declaration.
 */
export const make = <const Name extends string, I, A, const O extends MakeOptions = {}>(
  name: Name,
  service: Context.Key<I, A>,
  ...options: OptionalUnless<O, O & NoInfer<Known<O, MakeOptions>>>
): Descriptor<I, A, SecurityOf<O>, Name> => {
  const security: Security = options[0]?.security ?? HttpApiSecurity.bearer;

  if (!componentKey.test(name)) {
    throw new Error(`Invalid authentication name: ${JSON.stringify(name)}, not an OpenAPI key`);
  }

  // Checked at run time too: plain JavaScript can pass anything, a record of schemes included.
  if (
    !Predicate.isTagged(security, "Http") &&
    !Predicate.isTagged(security, "ApiKey") &&
    !Predicate.isTagged(security, "Basic")
  ) {
    throw new Error("Authentication takes one native HttpApiSecurity scheme");
  }

  return {
    name,
    service,
    // SAFETY: `SecurityOf` is the scheme given, or Bearer wherever it may be left out.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A type read from the options.
    security: security as SecurityOf<O>,
    "~provider": Context.Service<Provider<I, Name>, Runtime>(
      `effect-actions/Authentication/Provider/${name}`,
    ),
    "~middleware": HttpApiMiddleware.Service<SecurityMiddleware<I, Name>, { provides: I }>()(
      `effect-actions/Authentication/Security/${name}`,
      { security: { [name]: security } },
    ),
    "~verified": Context.Service<never, unknown>(`effect-actions/Authentication/Verified/${name}`),
  };
};

export type { Any } from "./internal/authentication.js";

/**
 * A descriptor's verifier: the credential its scheme decodes, as Effect's own decoder gives
 * it, to the identity, or a refusal. Its services belong to the request.
 */
export type Verify<A, S extends Security, R> = (
  credential: HttpApiSecurity.HttpApiSecurity.Type<S>,
) => Effect.Effect<A, Refusal | HttpServerResponse.HttpServerResponse, R>;

export interface LayerOptions<EP = never, RP = never> {
  readonly protectedResource?: Options | Effect.Effect<Options | undefined, EP, RP>;
}

/**
 * Only a Bearer scheme publishes an OAuth protected resource. The types tell only an `Http`
 * scheme from the others, as its scheme is a `string`: `layer` refuses another `Http` one.
 */
type ResourceOf<S> = [S] extends [HttpApiSecurity.Http]
  ? unknown
  : { readonly protectedResource?: undefined };

/** Whether `credential`, as a native scheme decodes it, holds anything: an absent one is empty. */
const presented = (credential: Credential): boolean =>
  Redacted.isRedacted(credential)
    ? Redacted.value(credential) !== ""
    : credential.username !== "" || Redacted.value(credential.password) !== "";

/**
 * The provider of `auth`: `verify`, or an Effect building it once per layer graph, run on
 * each remote request a protected action receives, with the credential the descriptor's
 * scheme decodes. A Bearer scheme answers each 401 with its challenge, and may publish the
 * OAuth protected resource `protectedResource`.
 */
export function layer<
  const Name extends string,
  I,
  A,
  const S extends Security,
  R,
  EX = never,
  RX = never,
  EP = never,
  RP = never,
>(
  auth: Descriptor<I, A, S, Name>,
  verify:
    | Verify<NoInfer<A>, NoInfer<S>, R>
    | Effect.Effect<Verify<NoInfer<A>, NoInfer<S>, R>, EX, RX>,
  options?: LayerOptions<EP, RP> & ResourceOf<S>,
): Layer.Layer<
  Provider<I, Name>,
  EX | EP,
  | HttpRouter.HttpRouter
  | Exclude<RX | RP, Scope.Scope>
  | HttpRouter.Request.From<"Requires", Exclude<R, HttpRouter.Provided>>
>;
export function layer(
  auth: Any,
  verify:
    | Verify<unknown, Security, unknown>
    | Effect.Effect<Verify<unknown, Security, unknown>, unknown, unknown>,
  options: LayerOptions<unknown, unknown> = {},
): Layer.Layer<Provider<unknown>, unknown, unknown> {
  const { security } = auth;
  // Bearer is the scheme OAuth clients challenge, discover and step up under.
  const oauth = isBearer(security);
  const protectedResource = options.protectedResource;

  if (!oauth && protectedResource !== undefined) {
    throw new Error("A protected resource is published only for a Bearer scheme");
  }

  const resource = Effect.isEffect(protectedResource)
    ? Effect.map(protectedResource, answersOf)
    : Effect.succeed(answersOf(protectedResource));

  const missing = new Unauthenticated({
    message: oauth ? "A bearer token is required." : "A credential is required.",
  });

  return Layer.effect(
    auth["~provider"],
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const { metadataUrl, invalid, anonymous, published } = yield* resource;

      if (published !== undefined) yield* router.addGlobalMiddleware(published);

      const verifier = Effect.isEffect(verify) ? yield* verify : verify;

      if (!Predicate.isFunction(verifier)) {
        return yield* Effect.die(
          new Error("Missing verify: pass a verify function, or an Effect building one"),
        );
      }

      // An empty credential, which the native decoder gives for one absent, never verifies.
      const authenticate = (credential: Credential) =>
        presented(credential) ? verifier(credential) : Effect.fail(missing);

      // A response made of a covered route's failure elsewhere, such as by enclosing
      // middleware, may carry what the route failed with, whatever caching it states.
      const failed = HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
      );

      // Another scheme's 401 names that scheme, and no OAuth client steps up under it: a
      // refusal is answered as any other failure of the route. A Bearer 401 tells a caller
      // who presented a token that it is invalid.
      const challengeOf = (credential: Credential) =>
        !oauth ? schemeChallenge(security, auth.name) : presented(credential) ? invalid : anonymous;

      const refuse = (error: HttpServerResponse.HttpServerResponse | Refusal) =>
        Effect.succeed(
          HttpServerResponse.isHttpServerResponse(error)
            ? error
            : oauth
              ? answer(error, metadataUrl)
              : plain(error),
        );

      // `route` once `credential` verifies, given the identity as `slot`; refused otherwise.
      const verified = (
        credential: Credential,
        route: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown>,
        slot: Context.Key<unknown, unknown>,
      ) => {
        const challenge = challengeOf(credential);

        return Effect.matchEffect(authenticate(credential), {
          onFailure: refuse,
          onSuccess: (actor) => Effect.provideService(route, slot, actor),
        }).pipe(
          Effect.onError(() => failed),
          HttpEffect.withPreResponseHandler((_request, response) =>
            Effect.succeed(settle(response, challenge)),
          ),
        );
      };

      return {
        // HTTP: the native security middleware decodes the credential, and the route gets
        // the identity itself.
        middleware: {
          [auth.name]: (
            route: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown>,
            { credential }: { readonly credential: Credential },
          ) => verified(credential, route, auth.service),
        },
        // HTTP: a step-up refusal leaving the layer's middleware is answered with its
        // challenge; one the middleware turned into another failure, or recovered from, is not.
        stepUp: (route) =>
          oauth
            ? Effect.catchIf(route, isStepUp, (error) => Effect.succeed(answer(error, metadataUrl)))
            : route,
        // MCP: the request is decoded here, and a protected tool's call promotes what it
        // verified. A public one presenting no credential, which the scheme decodes as empty,
        // passes signed out.
        // SAFETY: verifier failures become responses; request requirements are restored by
        // layer's public signature as HttpRouter.Request markers, never startup identities.
        http: ((route, optional) =>
          Effect.flatMap(
            HttpApiBuilder.securityDecode(security),
            (credential) =>
              optional && !presented(credential)
                ? route
                : verified(
                    credential,
                    oauth ? answerStepUp(route, metadataUrl) : route,
                    auth["~verified"],
                  ),
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased authentication adapter boundary.
          )) as Runtime["http"],
      };
    }),
  );
}
