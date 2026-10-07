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
  type Errors,
  type Provider,
  type Runtime,
  type Security,
  type SecurityMiddleware,
  type VerifierFailure,
} from "./internal/authentication.js";
import { assertOwnTags, errorList } from "./internal/actions.js";
import { declaredResponse, type ErrorsOf } from "./internal/declared.js";
import { type Refusal, scopeToken, Unauthenticated } from "./internal/errors.js";
import type { Known, OptionalUnless } from "./internal/implementation.js";
import {
  answer,
  answerStepUp,
  bearer,
  challenge,
  isRefusal,
  isStepUp,
  plain,
} from "./internal/refusal.js";

/**
 * An `Authorization` header of the `Bearer` scheme, and its token, as Effect's own
 * `HttpApiSecurity.bearer` decodes a request's: the scheme, matched case-insensitively, one or
 * more spaces, then the rest of the header, whatever it holds. The whitespace around a header
 * value is no part of it, and an HTTP parser strips it before any route reads it.
 */
const bearerScheme = /^[ \t]*Bearer +([^ \t](?:.*[^ \t])?)[ \t]*$/i;

/**
 * The bearer token of an `Authorization` header, `authorization`, or none, read as Effect's
 * `HttpApiSecurity.bearer` reads it for routes and MCP, which a test holds equal. It is for a
 * caller the router never routes, which holds the header and no request; a route of the host's
 * own is authenticated by `protect`. The scheme is matched case-insensitively, as RFC 9110
 * requires, and the token is `Redacted`, as Effect's own decoder gives it.
 */
export const bearerTokenOf = (
  authorization: string | undefined,
): Option.Option<Redacted.Redacted<string>> =>
  Option.map(
    Option.fromNullishOr(bearerScheme.exec(authorization ?? "")?.[1]),
    (token): Redacted.Redacted<string> => Redacted.make(token),
  );

/** An OAuth protected resource (RFC 9728), as `layer` publishes it. */
export interface ProtectedResource {
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
const metadataUrl = (options: ProtectedResource): URL => {
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

/** What challenges about `options` name. */
const namedOf = (options: ProtectedResource | undefined): Named => ({
  scope: options?.scopesRequired?.join(" "),
  metadataUrl: options === undefined ? undefined : metadataUrl(options).href,
});

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

/**
 * Refuse a protected resource that cannot be published, as `layer` and `refusalResponse` both
 * do: one under a scheme other than Bearer (`oauth` false), a `scopesRequired` that is no list
 * of OAuth scope tokens, as `Forbidden` refuses, and a resource with a fragment, which no
 * request URL carries, so its discovery would never answer (RFC 9728). A resource an Effect
 * builds is checked for its scheme alone, and for the rest once built.
 */
const assertResource = (
  oauth: boolean,
  options: ProtectedResource | Effect.Effect<unknown, unknown, unknown> | undefined,
): void => {
  if (options === undefined) return;

  if (!oauth) throw new Error("A protected resource is published only for a Bearer scheme");

  if (Effect.isEffect(options)) return;

  const invalid = options.scopesRequired?.find((scope) => !scopeToken.test(scope));

  if (invalid !== undefined) throw new Error(`Invalid scope in scopesRequired: "${invalid}"`);

  // `hash` is empty for a bare `#`, which the URL still keeps.
  if (new URL(options.resource).href.includes("#")) {
    throw new Error(`A protected resource has no fragment: ${options.resource}`);
  }
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

/** What `refusalResponse` answers about. */
export interface RefusalResponseOptions<D extends Any = Any> {
  /**
   * The descriptor refusing, whose scheme decides the challenge: Bearer's, below, when left
   * out; another scheme's 401 names that scheme, and nothing steps up under it. An error it
   * declares is sent as its endpoints declare it.
   */
  readonly authentication?: D | undefined;
  /** The OAuth protected resource refusing: the one given to `layer`. */
  readonly protectedResource?: ProtectedResource | undefined;
  /** The request's `Authorization` header, which decides whether a 401 names `invalid_token`. */
  readonly authorization?: string | undefined;
}

/** What the descriptor `D` declares its verifier fails with besides a refusal. */
type DeclaredOf<D> = D extends { readonly error: infer E extends Errors }
  ? E[number]["Type"]
  : never;

/**
 * The response `layer` answers a refusal with, for a caller the router never routes, such as
 * a Node `upgrade` handler admitting a socket: its status, its JSON, `Cache-Control: no-store`
 * and its challenge, an `Unauthenticated`'s `Bearer`, naming `invalid_token` when
 * `authorization` presented a bearer token, or the `insufficient_scope` of a `Forbidden`
 * naming scopes. Given the protected resource `layer` was, every challenge names its metadata
 * URL and a 401's its `scopesRequired`. Under a descriptor of another scheme, it is the JSON
 * and status alone, a 401 naming that scheme. An error `authentication` declares is sent as
 * its endpoints declare it, its JSON with its status. `HttpServerResponse.toWeb` gives it as a
 * web `Response`.
 */
export const refusalResponse = <D extends Any = never>(
  error: Refusal | DeclaredOf<D>,
  options?: RefusalResponseOptions<D>,
): HttpServerResponse.HttpServerResponse => {
  const authentication = options?.authentication;
  const oauth = authentication === undefined || isBearer(authentication.security);
  assertResource(oauth, options?.protectedResource);

  const named = namedOf(options?.protectedResource);

  const challenge =
    authentication !== undefined && !oauth
      ? schemeChallenge(authentication.security, authentication.name)
      : challengeOf(named, tokenPresented(options?.authorization));

  if (!isRefusal(error)) {
    const response = declaredResponse(authentication?.error ?? [], error);

    if (response === undefined) {
      throw new Error("Not a refusal, nor an error the authentication declares");
    }

    return settle(response, challenge);
  }

  return settle(oauth ? answer(error, named.metadataUrl) : plain(error), challenge);
};

/**
 * Whether a request URL may resolve to a discovery path, which every other request skips
 * parsing: the URL parser copies `.well-known` as it is, removing only a tab or a newline. Node
 * refuses a target holding those before routing; a platform passing one through still parses.
 */
const mayDiscover = /\.well-known|[\t\n\r]/;

/**
 * RFC 9728 discovery of `options` at its metadata URL, as global router middleware: it
 * answers before routing, so no route middleware, authentication included, ever covers it.
 * The metadata is public to every origin, as a browser client needs it after a 401: it
 * carries `Access-Control-Allow-Origin: *`, and discovery answers its own CORS preflight.
 * Where the host's CORS middleware runs before it, that policy answers the preflight and
 * adds its headers to reads, which keep the `*` where it sets no origin.
 */
const discovery = (options: ProtectedResource) => {
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
        mayDiscover.test(request.url) &&
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
const answersOf = (options: ProtectedResource | undefined) => {
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
export interface Options {
  /** The one native scheme a caller proves the identity by: Bearer when left out. */
  readonly security?: Security;
  /**
   * What the verifier may fail with besides a refusal, such as its provider being unreachable:
   * one schema, or a list. Every protected endpoint declares it, so clients decode it.
   */
  readonly error?: Errors | Errors[number];
}

/** The scheme options `O` give: Bearer too wherever they may leave it out, as at run time. */
type SecurityOf<O> = O extends { readonly security: infer S extends Security }
  ? S
  : "security" extends keyof O
    ? NonNullable<O["security" & keyof O]> | HttpApiSecurity.Http
    : HttpApiSecurity.Http;

/**
 * Browser-safe declaration shared by clients and remote surfaces: the `identity` it
 * authenticates, by the one native scheme `security`, Bearer unless it names another, such
 * as `HttpApiSecurity.apiKey({ in: "cookie", key: "session" })`. The literal name
 * identifies the provider, like a native Context.Key name, and the scheme's OpenAPI key, so it
 * holds only letters, digits, `_`, `.` and `-`; reuse one name only for one declaration.
 */
export const make = <const Name extends string, I, A, const O extends Options = {}>(
  name: Name,
  identity: Context.Key<I, A>,
  ...options: OptionalUnless<O, O & NoInfer<Known<O, Options>>>
): Descriptor<I, A, SecurityOf<O>, Name, ErrorsOf<O>> => {
  const security: Security = options[0]?.security ?? HttpApiSecurity.bearer;
  const error = errorList(options[0]?.error);

  if (!componentKey.test(name)) {
    throw new Error(`Invalid authentication name: ${JSON.stringify(name)}, not an OpenAPI key`);
  }

  assertOwnTags(`Authentication "${name}"`, error);

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
    identity,
    // SAFETY: `SecurityOf` is the scheme given, or Bearer wherever it may be left out.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A type read from the options.
    security: security as SecurityOf<O>,
    // SAFETY: `ErrorsOf` is the list given, one schema as a list of one, or none.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A type read from the options.
    error: error as ErrorsOf<O>,
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

/**
 * A descriptor `make` returns, and the provider of its verifier `layer` returns, named so a
 * package emitting declarations can export them, and a binding naming one.
 */
export type { Any, Descriptor, Provider } from "./internal/authentication.js";

/**
 * A descriptor's verifier: the credential its scheme decodes, as Effect's own decoder gives
 * it, to the identity, or a refusal, or an error the descriptor declares, `E`. Its services
 * belong to the request.
 */
export type Verify<A, S extends Security, R, E = never> = (
  credential: HttpApiSecurity.HttpApiSecurity.Type<S>,
) => Effect.Effect<A, Refusal | E, R>;

export interface LayerOptions<EP = never, RP = never> {
  readonly protectedResource?:
    | ProtectedResource
    | Effect.Effect<ProtectedResource | undefined, EP, RP>;
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
 * The provider of `authentication`: `verify`, or an Effect building it once per layer graph, run on
 * each remote request a protected action receives, with the credential the descriptor's
 * scheme decodes. A Bearer scheme answers each 401 with its challenge, and may publish the
 * OAuth protected resource `protectedResource`.
 */
export function layer<
  const Name extends string,
  I,
  A,
  const S extends Security,
  E extends Errors,
  R,
  EX = never,
  RX = never,
  EP = never,
  RP = never,
>(
  authentication: Descriptor<I, A, S, Name, E>,
  verify:
    | Verify<NoInfer<A>, NoInfer<S>, R, NoInfer<E[number]["Type"]>>
    | Effect.Effect<Verify<NoInfer<A>, NoInfer<S>, R, NoInfer<E[number]["Type"]>>, EX, RX>,
  options?: LayerOptions<EP, RP> & ResourceOf<S>,
): Layer.Layer<
  Provider<I, Name>,
  EX | EP,
  | HttpRouter.HttpRouter
  | Exclude<RX | RP, Scope.Scope>
  | HttpRouter.Request.From<"Requires", Exclude<R, HttpRouter.Provided>>
>;
export function layer(
  authentication: Any,
  verify:
    | Verify<unknown, Security, unknown, unknown>
    | Effect.Effect<Verify<unknown, Security, unknown, unknown>, unknown, unknown>,
  options: LayerOptions<unknown, unknown> = {},
): Layer.Layer<Provider<unknown>, unknown, unknown> {
  const { security } = authentication;
  // Bearer is the scheme OAuth clients challenge, discover and step up under.
  const oauth = isBearer(security);
  const protectedResource = options.protectedResource;
  assertResource(oauth, protectedResource);

  const resource = Effect.isEffect(protectedResource)
    ? Effect.map(protectedResource, (built) => {
        assertResource(oauth, built);

        return answersOf(built);
      })
    : Effect.succeed(answersOf(protectedResource));

  const missing = new Unauthenticated({
    message: oauth ? "A bearer token is required." : "A credential is required.",
  });

  return Layer.effect(
    authentication["~provider"],
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
        !oauth
          ? schemeChallenge(security, authentication.name)
          : presented(credential)
            ? invalid
            : anonymous;

      // A refusal, or an error the descriptor declares, sent as its endpoints declare it;
      // anything else the verifier fails with is a defect, as no client could decode it.
      const refuse = (error: VerifierFailure) =>
        isRefusal(error)
          ? Effect.succeed(oauth ? answer(error, metadataUrl) : plain(error))
          : Effect.suspend(() => {
              const response = declaredResponse(authentication.error, error);

              return response === undefined ? Effect.die(error) : Effect.succeed(response);
            });

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
          [authentication.name]: (
            route: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown>,
            { credential }: { readonly credential: Credential },
          ) => verified(credential, route, authentication.identity),
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
                    authentication["~verified"],
                  ),
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased authentication adapter boundary.
          )) as Runtime["http"],
        // A route of the host's own: decoded here, as MCP's, given the identity as an action's
        // handler is, and a refusal it fails with, such as a scope check's `Forbidden`, is
        // answered as an action route's, stepping up under Bearer.
        // SAFETY: as `http` above.
        route: ((route: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown>) =>
          Effect.flatMap(
            HttpApiBuilder.securityDecode(security),
            (credential) =>
              verified(
                credential,
                Effect.catchIf(route, isRefusal, refuse),
                authentication.identity,
              ),
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased authentication adapter boundary.
          )) as Runtime["route"],
      };
    }),
  );
}

/** The identity `I`, or none where it is erased to `unknown`. */
type Provides<I> = unknown extends I ? never : I;

/**
 * Native router middleware authenticating a route of the host's own, such as an export, a
 * page frame or a WebSocket upgrade, with `authentication`'s provider, as its actions' routes
 * are: the credential its scheme decodes, verified by the same verifier, and the identity
 * provided to the route. It answers as an action route: a missing or invalid credential with
 * the refusal, every response to the request it authenticates `no-store` unless it states its
 * own caching, and a refusal the route fails with, such as a scope check's `Forbidden`, as its
 * status, JSON and challenge, stepping up under Bearer. The layer requires the provider,
 * `layer(authentication, ...)`. An erased descriptor, `Any`, provides no service the types can
 * name: its identity is `unknown`, which would discharge every request service the route owes.
 */
export const protect = <I, A, S extends Security, Name extends string, E extends Errors>(
  authentication: Descriptor<I, A, S, Name, E>,
): HttpRouter.Middleware<{
  provides: Provides<I>;
  handles: Refusal;
  error: never;
  requires: never;
  layerError: never;
  layerRequires: Provider<I, Name>;
}> =>
  HttpRouter.middleware<{ provides: Provides<I>; handles: Refusal }>()(
    Effect.map(
      Effect.service(authentication["~provider"]),
      (runtime) => (route) => runtime.route(route),
    ),
  );
