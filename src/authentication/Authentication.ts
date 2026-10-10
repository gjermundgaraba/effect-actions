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
import type {
  Any,
  Credential,
  Descriptor,
  Provider,
  Runtime,
  Security,
  SecurityMiddleware,
  VerifierFailure,
} from "./provider.js";
import type { Errors } from "../contract/Action.js";
import { assertOwnTags, errorList, type ErrorsOf } from "../contract/rules.js";
import { declaredResponse } from "../http/declared.js";
import { type Refusal, scopeToken, Unauthenticated } from "../contract/errors.js";
import type { Known, OptionalUnless } from "../contract/implementation.js";
import { answer, answerStepUp, bearer, challenge, isRefusal, isStepUp, plain } from "./refusal.js";

const bearerAuthorizationHeader = /^[ \t]*Bearer +(.*[^ \t])[ \t]*$/i;

/**
 * The bearer token of an `Authorization` header, `authorization`, or none, read as Effect's
 * `HttpApiSecurity.bearer` reads it for routes and MCP, which a test holds equal. It is for a
 * caller the router never routes, which holds the header and no request; a route of the host's
 * own is authenticated by `protect`. The scheme is matched case-insensitively, as RFC 9110
 * requires, and the token is `Redacted`, as Effect's own decoder gives it.
 */
export const bearerTokenOf = (
  authorization: string | null | undefined,
): Option.Option<Redacted.Redacted<string>> =>
  Option.map(
    Option.fromNullishOr(bearerAuthorizationHeader.exec(authorization ?? "")?.[1]),
    (token): Redacted.Redacted<string> => Redacted.make(token),
  );

/** An OAuth protected resource (RFC 9728), as `layer` publishes it. */
export interface ProtectedResource {
  /**
   * Exact OAuth resource identifier; its path and query select the discovery path. It has no
   * fragment, which no request URL carries, so its discovery would never answer (RFC 9728).
   */
  readonly resource: string;
  /** Where clients get tokens: nonempty. */
  readonly authorizationServers: Arr.NonEmptyReadonlyArray<string>;
  /**
   * Every scope the resource accepts, each an OAuth scope token, which a client requests when a
   * 401 names none.
   */
  readonly scopesSupported?: ReadonlyArray<string>;
  /**
   * The scopes every 401 names, each an OAuth scope token: what a client requests when it
   * authenticates, rather than every scope supported. A `Forbidden` naming scopes asks for
   * more when a call needs them.
   */
  readonly scopesRequired?: Arr.NonEmptyReadonlyArray<string>;
  readonly resourceName?: string;
}

const metadataUrlOf = (options: ProtectedResource): URL => {
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

const namedOf = (options: ProtectedResource | undefined): Named => ({
  scope: options?.scopesRequired?.join(" "),
  metadataUrl: options === undefined ? undefined : metadataUrlOf(options).href,
});

const presentsBearerToken = (authorization: string | null | undefined): boolean =>
  Option.isSome(bearerTokenOf(authorization));

const bearerChallengeOf = (named: Named, presented: boolean): string =>
  bearer([
    ["error", presented ? "invalid_token" : undefined],
    ["scope", named.scope],
    ["resource_metadata", named.metadataUrl],
  ]);

const assertPublishableResource = (
  oauth: boolean,
  options: ProtectedResource | Effect.Effect<unknown, unknown, unknown> | undefined,
): void => {
  if (options === undefined) return;

  if (!oauth) throw new Error("A protected resource is published only for a Bearer scheme");

  if (Effect.isEffect(options)) return;

  for (const key of ["scopesSupported", "scopesRequired"] as const) {
    const invalid = options[key]?.find((scope) => !scopeToken.test(scope));

    if (invalid !== undefined) throw new Error(`Invalid scope in ${key}: "${invalid}"`);
  }

  if (new URL(options.resource).href.includes("#")) {
    throw new Error(`A protected resource has no fragment: ${options.resource}`);
  }
};

const withNoStoreAndChallenge = (
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
  /**
   * The request's `Authorization` header, as the web `Headers.get` gives it, which decides whether a
   * 401 names `invalid_token`.
   */
  readonly authorization?: string | null | undefined;
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
  assertPublishableResource(oauth, options?.protectedResource);

  const named = namedOf(options?.protectedResource);

  const challenge =
    authentication !== undefined && !oauth
      ? nonBearerChallengeOf(authentication.security, authentication.name)
      : bearerChallengeOf(named, presentsBearerToken(options?.authorization));

  if (!isRefusal(error)) {
    const response = declaredResponse(authentication?.error ?? [], error);

    if (response === undefined) {
      throw new Error("Not a refusal, nor an error the authentication declares");
    }

    return withNoStoreAndChallenge(response, challenge);
  }

  return withNoStoreAndChallenge(
    oauth ? answer(error, named.metadataUrl) : plain(error),
    challenge,
  );
};

const mayResolveToDiscoveryPath = /\.well-known|[\t\n\r]/;

const discoveryMiddleware = (options: ProtectedResource) => {
  const discoveryUrl = metadataUrlOf(options);
  const target = discoveryUrl.href.slice(discoveryUrl.origin.length);

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

  const corsPreflight = (request: HttpServerRequest.HttpServerRequest) => {
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

  return <E, R>(next: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const targeted =
        mayResolveToDiscoveryPath.test(request.url) &&
        URL.canParse(request.url, discoveryUrl.origin) &&
        new URL(request.url, discoveryUrl.origin).href.slice(discoveryUrl.origin.length) === target;

      if (targeted && (request.method === "GET" || request.method === "HEAD"))
        return Effect.succeed(metadata);

      if (targeted && request.method === "OPTIONS") return Effect.succeed(corsPreflight(request));

      return next;
    });
};

const resourceAnswersOf = (options: ProtectedResource | undefined) => {
  const named = namedOf(options);

  return {
    metadataUrl: named.metadataUrl,
    invalid: bearerChallengeOf(named, true),
    anonymous: bearerChallengeOf(named, false),
    published: options === undefined ? undefined : discoveryMiddleware(options),
  };
};

const isBearer = (security: Security): boolean =>
  Predicate.isTagged(security, "Http") && security.scheme.toLowerCase() === "bearer";

const openApiComponentKey = /^[\w.-]+$/;

const nonBearerChallengeOf = (security: Security, name: string): string | undefined =>
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

  if (!openApiComponentKey.test(name)) {
    throw new Error(`Invalid authentication name: ${JSON.stringify(name)}, not an OpenAPI key`);
  }

  assertOwnTags(`Authentication "${name}"`, error);

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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A type read from the options: `SecurityOf` is the scheme given, or Bearer wherever it may be left out.
    security: security as SecurityOf<O>,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A type read from the options: `ErrorsOf` is the list given, one schema as a list of one, or none.
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

export type { Any, Descriptor, Provider } from "./provider.js";

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

const presented = (credential: Credential): boolean =>
  Redacted.isRedacted(credential)
    ? Redacted.value(credential) !== ""
    : credential.username !== "" || Redacted.value(credential.password) !== "";

/** What `protectedResource` is given: the resource, an Effect building it, or none. */
type Resource =
  | ProtectedResource
  | Effect.Effect<ProtectedResource | undefined, unknown, unknown>
  | undefined;

/**
 * The provider of `authentication`: `verify`, or an Effect building it once per layer graph, run on
 * each remote request a protected action receives, with the credential the descriptor's
 * scheme decodes. A Bearer scheme answers each 401 with its challenge, and may publish the
 * OAuth protected resource `protectedResource`, on the `HttpRouter` it then requires.
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
  P extends Resource = undefined,
>(
  authentication: Descriptor<I, A, S, Name, E>,
  verify:
    | Verify<NoInfer<A>, NoInfer<S>, R, NoInfer<E[number]["Type"]>>
    | Effect.Effect<Verify<NoInfer<A>, NoInfer<S>, R, NoInfer<E[number]["Type"]>>, EX, RX>,
  options?: { readonly protectedResource?: P } & ResourceOf<S>,
): Layer.Layer<
  Provider<I, Name>,
  EX | Effect.Error<P>,
  | ([P] extends [undefined] ? never : HttpRouter.HttpRouter)
  | Exclude<RX | Effect.Services<P>, Scope.Scope>
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
  const oauth = isBearer(security);
  const protectedResource = options.protectedResource;
  assertPublishableResource(oauth, protectedResource);

  const resource = Effect.isEffect(protectedResource)
    ? Effect.map(protectedResource, (built) => {
        assertPublishableResource(oauth, built);

        return resourceAnswersOf(built);
      })
    : Effect.succeed(resourceAnswersOf(protectedResource));

  const missing = new Unauthenticated({
    message: oauth ? "A bearer token is required." : "A credential is required.",
  });

  return Layer.effect(
    authentication["~provider"],
    Effect.gen(function* () {
      const { metadataUrl, invalid, anonymous, published } = yield* resource;

      if (published !== undefined) {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.addGlobalMiddleware(published);
      }

      const verifier = Effect.isEffect(verify) ? yield* verify : verify;

      if (!Predicate.isFunction(verifier)) {
        return yield* Effect.die(
          new Error("Missing verify: pass a verify function, or an Effect building one"),
        );
      }

      const authenticate = (credential: Credential) =>
        presented(credential) ? verifier(credential) : Effect.fail(missing);

      const noStoreOnFailure = HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
      );

      const challengeOf = (credential: Credential) =>
        !oauth
          ? nonBearerChallengeOf(security, authentication.name)
          : presented(credential)
            ? invalid
            : anonymous;

      const refuse = (error: VerifierFailure) =>
        isRefusal(error)
          ? Effect.succeed(oauth ? answer(error, metadataUrl) : plain(error))
          : Effect.suspend(() => {
              const response = declaredResponse(authentication.error, error);

              return response === undefined ? Effect.die(error) : Effect.succeed(response);
            });

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
          Effect.onError(() => noStoreOnFailure),
          HttpEffect.withPreResponseHandler((_request, response) =>
            Effect.succeed(withNoStoreAndChallenge(response, challenge)),
          ),
        );
      };

      return {
        descriptor: authentication,
        authenticate,
        middleware: {
          [authentication.name]: (
            route: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown>,
            { credential }: { readonly credential: Credential },
          ) => verified(credential, route, authentication.identity),
        },
        stepUp: (route) =>
          oauth
            ? Effect.catchIf(route, isStepUp, (error) => Effect.succeed(answer(error, metadataUrl)))
            : route,
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
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased authentication adapter boundary: verifier failures become responses, and `layer`'s signature restores the request requirements as `HttpRouter.Request` markers, never startup identities.
          )) as Runtime["http"],
        route: ((route: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown>) =>
          Effect.flatMap(
            HttpApiBuilder.securityDecode(security),
            (credential) =>
              verified(
                credential,
                Effect.catchIf(route, isRefusal, refuse),
                authentication.identity,
              ),
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased authentication adapter boundary: verifier failures become responses, and `layer`'s signature restores the request requirements as `HttpRouter.Request` markers, never startup identities.
          )) as Runtime["route"],
      };
    }),
  );
}

/** The identity `I`, or none where it is erased to `unknown`. */
type Provides<I> = unknown extends I ? never : I;

/**
 * What `protect` returns for a descriptor named `Name` authenticating the identity `I`: router
 * middleware providing it, answering a refusal its routes fail with, and requiring the
 * descriptor's provider. Named so a package emitting declarations can export one.
 */
export type Protection<I, Name extends string> = HttpRouter.Middleware<{
  provides: Provides<I>;
  handles: Refusal;
  error: never;
  requires: never;
  layerError: never;
  layerRequires: Provider<I, Name>;
}>;

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
): Protection<I, Name> =>
  HttpRouter.middleware<{ provides: Provides<I>; handles: Refusal }>()(
    Effect.map(
      Effect.service(authentication["~provider"]),
      (runtime) => (route) => runtime.route(route),
    ),
  );
