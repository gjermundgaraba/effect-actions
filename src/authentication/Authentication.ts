import {
  type Array as Arr,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  type Schema,
  type Scope,
} from "effect";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import {
  type Any,
  type Credential,
  type Descriptor,
  type Provider,
  providerOf,
  type Runtime,
  type Security,
  type SecurityMiddleware,
  type VerifierFailure,
} from "./provider.js";
import type { Errors } from "../contract/Action.js";
import type { Codec } from "../contract/codec.js";
import { assertDistinctTags, errorList, type ErrorsOf } from "../contract/declared.js";
import { builtIns, type Refusal, scopeToken, Unauthenticated } from "../contract/errors.js";
import type { Known, OptionalUnless } from "../contract/implementation.js";
import {
  answer,
  answerStepUp,
  bearer,
  challenge,
  declaredResponse,
  isRefusal,
  isStepUp,
  plain,
} from "./refusal.js";

const bearerAuthorizationHeader = /^[ \t]*Bearer +(.*[^ \t])[ \t]*$/i;

/**
 * The bearer token of an `Authorization` header, `authorization`, or none, read as Effect's
 * `HttpApiSecurity.bearer` reads it for routes and MCP: the scheme matched case-insensitively,
 * as RFC 9110 requires, and the token `Redacted`. It is for a caller the router never routes,
 * which holds the header and no request; a route of the host's own is authenticated by
 * `protect`.
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
   * Exact OAuth resource identifier: the public URL of the endpoint clients connect to, such as
   * `${url}/mcp`. Discovery is served at `/.well-known/oauth-protected-resource` followed by its
   * path and query.
   *
   * **Gotchas**
   *
   * - Discovery answers 404, and an MCP client finds no authorization server, when a request's path and query differ from this URL's, or when the provider is provided to no served layer.
   * - That it and `authorizationServers` are HTTPS, or loopback HTTP in development, is the deployment's to ensure: nothing checks it.
   */
  readonly resource: string;
  /** Where clients get tokens, your authorization servers' issuers: nonempty. */
  readonly authorizationServers: Arr.NonEmptyReadonlyArray<string>;
  /**
   * Every scope the resource accepts, each an OAuth scope token, which a client requests when a
   * 401 names none.
   */
  readonly scopesSupported?: ReadonlyArray<string>;
  /**
   * The scopes every 401 names, each an OAuth scope token: what a client requests when it
   * authenticates, rather than every scope supported.
   *
   * **Gotchas**
   *
   * - Give it whenever some actions need scopes others do not, or a user who only reads is asked to consent to writes on first login.
   */
  readonly scopesRequired?: Arr.NonEmptyReadonlyArray<string>;
  /** A human-readable name of the resource, published as `resource_name`. */
  readonly resourceName?: string;
}

const metadataUrlOf = (options: ProtectedResource): URL => {
  const resource = new URL(options.resource);
  const url = new URL(resource);
  url.pathname = `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`;

  return url;
};

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

  if (!oauth) {
    throw new Error(
      "A protected resource is published only for a Bearer scheme: drop `protectedResource`, or authenticate with a Bearer descriptor",
    );
  }

  if (Effect.isEffect(options)) return;

  for (const key of ["scopesSupported", "scopesRequired"] as const) {
    const invalid = options[key]?.find((scope) => !scopeToken.test(scope));

    if (invalid !== undefined) {
      throw new Error(
        `Invalid scope in ${key}: "${invalid}", not an OAuth scope token: give each scope as its own element, of printable ASCII without a space, '"' or '\\'`,
      );
    }
  }

  const resource = URL.parse(options.resource);

  if (resource === null) {
    throw new Error(
      `A protected resource is an absolute URL: ${JSON.stringify(options.resource)} is not one; give the public URL of the endpoint clients connect to, such as https://api.example.com/mcp, read from configuration`,
    );
  }

  if (resource.href.includes("#")) {
    throw new Error(
      `A protected resource has no fragment: ${options.resource}; drop the "#", which no request URL carries, so its discovery would never answer`,
    );
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
   * The descriptor refusing, whose scheme decides the challenge as on its routes: Bearer's when
   * left out, as `protectedResource` and `authorization` shape it; what another scheme gives up
   * is on `Options.security`. An error it declares is sent as its endpoints declare it.
   */
  readonly authentication?: D | undefined;
  /**
   * The OAuth protected resource refusing, the one given to `layer`: every challenge then names
   * its metadata URL, and a 401's its `scopesRequired`. Where `layer` builds the resource from
   * configuration, build this one from the same configuration.
   */
  readonly protectedResource?: ProtectedResource | undefined;
  /**
   * The request's `Authorization` header, as the web `Headers.get` gives it, which decides whether a
   * 401 names `invalid_token`.
   */
  readonly authorization?: string | null | undefined;
}

type DeclaredOf<D> = D extends { readonly error: infer E extends Errors }
  ? E[number]["Type"]
  : never;

/**
 * The response `layer` answers a refusal with, for a caller the router never routes, such as a
 * Node `upgrade` handler admitting a socket, which holds a header and no request: read its token
 * with `bearerTokenOf`, verify it with the routes' verifier, and answer a failure with this. It
 * holds the refusal's status and JSON, `Cache-Control: no-store` and the challenge `options`
 * decide: under Bearer an `Unauthenticated`'s, or the `insufficient_scope` of a `Forbidden`
 * naming scopes. `HttpServerResponse.toWeb` gives it as a web `Response`.
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
      throw new Error(
        "Not a refusal, nor an error the authentication declares: pass the descriptor declaring it as `authentication`, or answer the error yourself",
      );
    }

    return withNoStoreAndChallenge(response, challenge);
  }

  return withNoStoreAndChallenge(
    oauth ? answer(error, named.metadataUrl) : plain(error),
    challenge,
  );
};

// Why: A prefilter sparing most requests a URL parse, which must admit every URL the parser may
// resolve to a discovery path. The parser copies `.well-known` as it is and removes only a tab or a
// newline, which Node refuses in a request target but another platform may pass through.
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

/** What `make` takes besides the name and the identity `A`. */
export interface Options<A = unknown> {
  /**
   * The one native scheme a caller proves the identity by, Bearer when left out: an API key in a
   * cookie, a header or the query, such as `HttpApiSecurity.apiKey({ in: "cookie", key: "session" })`,
   * or `HttpApiSecurity.basic`. Only Bearer speaks OAuth: discovery, challenges naming scopes, and
   * step-up.
   *
   * **Gotchas**
   *
   * - One scheme per descriptor, with no fallback: a host accepting two credentials for one identity declares two descriptors and serves them on two bindings or endpoints.
   */
  readonly security?: Security;
  /**
   * What the verifier may fail with besides a refusal, such as its provider being unreachable:
   * one schema, or a list. Every protected endpoint declares it, so clients decode it.
   *
   * **Gotchas**
   *
   * - A failure that is not the caller's, such as an issuer the verifier cannot reach, belongs here with `{ httpApiStatus: 503 }`: an `Unauthenticated` would have the caller sign in again.
   */
  readonly error?: Errors | Errors[number];
  /**
   * The stable id of an identity, such as its user id: what tells subscribers apart where a
   * surface keeps a subscription between requests, such as an MCP poll subscription's lease.
   *
   * **Gotchas**
   *
   * - A surface serving a protected event type whose source has a `subscription` hook refuses to start without it, its message naming this option.
   * - Two identities with one principal share those subscriptions, so give each its own: a tenant's id alone merges its users.
   * - Without it no surface offers a protected event by webhook, which a subscription keys by its principal: the listing names no webhook, and a webhook subscription fails with `Event.SubscriptionError`, reason `Unsupported`.
   * - Without it every caller shares one idempotency key space: another caller sending a key with the same input is given the first call's answer, as `Action.Options.idempotencyKey` says.
   */
  readonly principal?: ((identity: A) => string) | undefined;
  /**
   * The identity's schema, its `Type` the identity: how a surface keeps an identity past a
   * restart, as `Webhook.layer` with `persist` keeps each webhook subscriber's, its JSON in the
   * store.
   *
   * **Gotchas**
   *
   * - `Webhook.layer` with `persist` refuses to serve a protected event by webhook without it, its message naming this option.
   */
  readonly schema?: Codec | undefined;
}

// Why: `principal` is checked apart from the inferred options, against the identity `make` was
// given, which also types its parameter: inferred with them, it would take an `any` identity.
type PrincipalOf<A> = NoInfer<Pick<Options<A>, "principal">>;

// Why: A given `schema` is checked against the identity here, both ways, since `Options` cannot
// type it: the options are bounded by `Options<never>`, which fixes the identity as `never` before
// `make` knows it. One way alone would take a schema of a wider or a narrower type.
type SchemaOf<O, A> = O extends { readonly schema: infer S extends Schema.Top }
  ? [S["Type"], A] extends [A, S["Type"]]
    ? unknown
    : { readonly schema: "a schema whose Type is the identity's" }
  : unknown;

type SecurityOf<O> = O extends { readonly security: infer S extends Security }
  ? S
  : "security" extends keyof O
    ? NonNullable<O["security" & keyof O]> | HttpApiSecurity.Http
    : HttpApiSecurity.Http;

/**
 * Browser-safe declaration shared by clients and remote surfaces: the `identity` it
 * authenticates, and the scheme a caller proves it by, `Options.security`. The literal name
 * identifies the provider, like a native Context.Key name, and the scheme's OpenAPI key; reuse
 * one name only for one declaration, whose values a server and a client may hold as `layer` says.
 * Guide: `docs/Authentication.md` in this package; in an application: `examples/notes-service/src/identity/`.
 */
export const make = <const Name extends string, I, A, const O extends Options<never> = {}>(
  name: Name,
  identity: Context.Key<I, A>,
  ...options: OptionalUnless<O, O & NoInfer<Known<O, Options>> & PrincipalOf<A> & SchemaOf<O, A>>
): Descriptor<I, A, SecurityOf<O>, Name, ErrorsOf<O>> => {
  const security: Security = options[0]?.security ?? HttpApiSecurity.bearer;
  const error = errorList(options[0]?.error);
  const principal = options[0]?.principal;
  const schema = options[0]?.schema;

  // Why: The name keys its scheme in the OpenAPI document as it is, so one that is no key throws.
  // Rejected: replacing other characters with `_`, which gives `app/Login` and `app:Login` one key,
  // which `OpenApi.fromApi` merges silently where their schemes are equal.
  if (!openApiComponentKey.test(name)) {
    throw new Error(
      `Invalid authentication name: ${JSON.stringify(name)}, not an OpenAPI key: use only letters, digits, "_", "." and "-"`,
    );
  }

  assertDistinctTags(`Authentication "${name}"`, [...builtIns, ...error]);

  if (
    !Predicate.isTagged(security, "Http") &&
    !Predicate.isTagged(security, "ApiKey") &&
    !Predicate.isTagged(security, "Basic")
  ) {
    throw new Error(
      "Authentication takes one native HttpApiSecurity scheme as `security`: omit it for Bearer, or give one scheme, such as `HttpApiSecurity.basic`, never a record of them",
    );
  }

  return {
    name,
    identity,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A type read from the options: `SecurityOf` is the scheme given, or Bearer wherever it may be left out.
    security: security as SecurityOf<O>,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A type read from the options: `ErrorsOf` is the list given, one schema as a list of one, or none.
    error: error as ErrorsOf<O>,
    ...(principal === undefined ? {} : { principal }),
    ...(schema === undefined ? {} : { schema }),
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
 * belong to the request; one it needs at startup, such as a user directory, is yielded by an
 * Effect that builds the verifier, given to `layer` in its place.
 *
 * **Gotchas**
 *
 * - The library reads no token: its signature, expiry and audience are the verifier's to check, with your authorization server's library; fail a token issued for another resource with `Unauthenticated`.
 * - Only a missing or empty credential is refused before it runs; Basic's reaches it when its username or its password is non-empty, so it may receive an empty username.
 */
export type Verify<A, S extends Security, R, E = never> = (
  credential: HttpApiSecurity.HttpApiSecurity.Type<S>,
) => Effect.Effect<A, Refusal | E, R>;

/** What `layer` takes besides the descriptor and the verifier. */
export interface LayerOptions<EP = never, RP = never> {
  /**
   * Bearer only: the OAuth protected resource (RFC 9728) to publish, or an Effect building it
   * when the provider is built; left out, or built as `undefined`, nothing is published. The
   * provider then serves its discovery and names it in every challenge, so an MCP client given a
   * 401 finds the authorization server; without it the challenge names nowhere to sign in.
   *
   * **Gotchas**
   *
   * - Under another scheme it is a type error, or, for an `Http` scheme the types cannot tell from Bearer, a throw at `layer`.
   * - A literal URL is right in one deployment only: in every other, the published `resource` and each challenge's metadata URL name another server, where an MCP client then looks for its authorization server; give an Effect reading configuration.
   * - Discovery is public: it answers before routing, to any origin, so no authentication and no route middleware covers it; global middleware covers it only when provided after the provider, as `examples/kitchen-sink/src/routes.ts` shows.
   */
  readonly protectedResource?:
    | ProtectedResource
    | Effect.Effect<ProtectedResource | undefined, EP, RP>;
}

// Why: Effect types an `Http` scheme's name as `string`, so the types cannot tell Bearer from
// another `Http` scheme; `assertPublishableResource` refuses the others when `layer` is called.
type ResourceOf<S> = [S] extends [HttpApiSecurity.Http]
  ? unknown
  : { readonly protectedResource?: undefined };

const presented = (credential: Credential): boolean =>
  Redacted.isRedacted(credential)
    ? Redacted.value(credential) !== ""
    : credential.username !== "" || Redacted.value(credential.password) !== "";

type Resource =
  | ProtectedResource
  | Effect.Effect<ProtectedResource | undefined, unknown, unknown>
  | undefined;

// Why: The verifier's per-request services stay this layer's to owe. Rejected: carrying them on
// `Provider` for the routes to owe, which the routes, typed from the browser-safe descriptor alone,
// could do only if the descriptor declared them: a new concept to save one wiring order.
/**
 * The provider of `authentication`: `verify`, or an Effect building it once per layer graph, run on
 * each remote request a protected action receives, and on every request presenting a credential
 * to an MCP endpoint that serves one, with the credential the descriptor's scheme decodes. A
 * Bearer scheme may publish the OAuth protected resource `protectedResource`, on the
 * `HttpRouter` it then requires.
 *
 * **Gotchas**
 *
 * - Call it once per descriptor, and provide that value to every layer serving a protected action: nothing else satisfies the provider they require, neither the identity nor another descriptor's provider, which type-checks under the same name and identity, then dies when the layer builds; only a client may hold another descriptor of the name, such as one of a cookie name the server decides at startup.
 * - Over `ActionRpc` a verifier reading `HttpServerRequest` reads one holding the message's headers alone, a socket's upgrade headers before its own, at `/` with no query or body, on every protocol: one judging the URL or query sees none of the client's.
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
  options?: {
    /** The OAuth protected resource to publish: its rules are on `LayerOptions.protectedResource`. */
    readonly protectedResource?: P;
  } & ResourceOf<S>,
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
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased authentication adapter boundary: verifier failures become responses, and `layer`'s signature restores the request requirements as `HttpRouter.Request` markers, never startup identities.
        http: ((route, optional) =>
          Effect.flatMap(HttpApiBuilder.securityDecode(security), (credential) =>
            optional && !presented(credential)
              ? route
              : verified(
                  credential,
                  oauth ? answerStepUp(route, metadataUrl) : route,
                  authentication["~verified"],
                ),
          )) as Runtime["http"],
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased authentication adapter boundary: verifier failures become responses, and `layer`'s signature restores the request requirements as `HttpRouter.Request` markers, never startup identities.
        route: ((route: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown>) =>
          Effect.flatMap(HttpApiBuilder.securityDecode(security), (credential) =>
            verified(credential, Effect.catchIf(route, isRefusal, refuse), authentication.identity),
          )) as Runtime["route"],
      };
    }),
  );
}

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
 * Native router middleware authenticating a route of the host's own, such as an export, a page
 * frame or a WebSocket upgrade, as its actions' routes are: the credential its scheme decodes,
 * verified by `authentication`'s provider, which its layer requires, and the identity provided
 * to the route. A missing or invalid credential, and a refusal the route fails with, such as a
 * scope check's `Forbidden`, are answered as on an action route: status, JSON and challenge,
 * stepping up under Bearer.
 *
 * **Gotchas**
 *
 * - No authorizer runs for its routes: each states its own authorization, such as by running the `authorize` of the action it mirrors.
 * - Every response to a request it covers is `Cache-Control: no-store` unless the route states its own caching; a route that does says `private` unless its answer is the same for every caller, or a cache in front of the server may serve it to anyone.
 * - A failure that enclosing middleware serializes is `no-store` whatever the route set: only a response the route itself returns keeps its caching.
 * - An erased descriptor, `Any`, provides no service the types can name: its identity is `unknown`, which would discharge every request service the route owes.
 */
export const protect = <I, A, S extends Security, Name extends string, E extends Errors>(
  authentication: Descriptor<I, A, S, Name, E>,
): Protection<I, Name> =>
  HttpRouter.middleware<{ provides: Provides<I>; handles: Refusal }>()(
    Effect.map(providerOf(authentication), (runtime) => (route) => runtime.route(route)),
  );
