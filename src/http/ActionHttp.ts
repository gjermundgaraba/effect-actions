import {
  Context,
  Effect,
  type FileSystem,
  Layer,
  type Path,
  type Schema,
  Scope,
  type Types,
} from "effect";
import type { Etag, HttpClient, HttpClientError, HttpPlatform } from "effect/http";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";
import type * as Action from "../contract/Action.js";
import {
  type Any as Authentication,
  type DescriptorOf,
  type Identity,
  type Matching,
  providerOf,
  type PublicOnly,
  type ServedProvider,
  type RemoteRequest,
  type Required as RequiredAuthentication,
  type ServerBuildServices,
  type VerifierError,
} from "../authentication/provider.js";
import { Anyone } from "../contract/caller.js";
import {
  type Certain,
  type ErrorsOf,
  projectedErrors,
  bindingErrors,
  bindingOf,
} from "../contract/declared.js";
import { declared } from "../contract/status.js";
import { type ErasedMethod, inputParseOptions } from "../contract/call.js";
import { type AnyHttp, type Client, methods, type Options as ClientOptions } from "./client.js";
import type { BuiltIn, BuiltIns } from "../contract/errors.js";
import { SchemaErrors, schemaErrors } from "./schema-errors.js";
import {
  type Protected,
  acquire,
  type BuildError,
  type ErasedValue,
  type Known,
  type Member,
  type MiddlewareOf,
  provideHandlers,
  type Served,
  type Serving,
  type Selected,
  type Holding,
  servingOf,
} from "../contract/implementation.js";

export type { Client } from "./client.js";

export type { MethodError } from "./client.js";

export type { AnyHttp as Any } from "./client.js";

export type { Options as ClientOptions } from "./client.js";

/** What `fetchClient` takes: `client`'s options, and the `fetch` its calls send with. */
export interface FetchClientOptions<
  E = HttpClientError.HttpClientError,
  R = never,
> extends ClientOptions<E, R> {
  /**
   * What each call sends with. Omitted: the global `fetch`, looked up on every call, so one
   * installed after the client is built, such as a test's stub, is used.
   *
   * **Gotchas**
   *
   * - A page on the API's own origin sends its cookies already; from another origin pass `(input, init) => fetch(input, { ...init, credentials: "include" })`, and the server's CORS must allow credentials, `HttpRouter.cors({ allowedOrigins, credentials: true })`.
   * - A `fetch` of your own passes `init.signal` on, or interrupting a call no longer aborts its request: a deadline is `Effect.timeout` on the call.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

type Middleware = ReadonlyArray<Context.Key<HttpApiMiddleware.AnyId, unknown>>;

type IdOf<K> = K extends Context.Key<infer I extends HttpApiMiddleware.AnyId, unknown> ? I : never;

type Through<M extends Middleware, R> = number extends M["length"]
  ? R | HttpApiMiddleware.Requires<IdOf<M[number]>>
  : M extends readonly [infer K, ...infer Rest extends Middleware]
    ? Through<
        Rest,
        true extends Types.IsUnion<IdOf<K>>
          ? R | HttpApiMiddleware.Requires<IdOf<K>>
          : HttpApiMiddleware.ApplyServices<IdOf<K>, R>
      >
    : R;

type ServerOnly<M extends Middleware, E extends Action.Errors> = [
  | Exclude<
      HttpApiMiddleware.Error<IdOf<M[number]>>,
      Extract<Certain<E>, Action.Errors[number]>["Type"] | BuiltIn
    >
  | HttpApiMiddleware.MiddlewareClient<IdOf<M[number]>>,
] extends [never]
  ? unknown
  : {
      readonly "Layer middleware fails only with the binding's errors and needs no client": never;
    };

type HttpLayer<
  H extends AnyHttp,
  Apps extends Served,
  M extends Middleware,
  A extends Action.Any = H["actions"][number],
> = Layer.Layer<
  never,
  BuildError<Holding<Member<Apps>, A>, A>,
  | ServerBuildServices<Holding<Member<Apps>, A>, A>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", LayerRequest<Member<Apps>, A, M>>
  | ServedProvider<Member<Apps>, A, H extends { readonly authentication: infer D } ? D : never>
  | IdOf<M[number]>
  | Etag.Generator
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path
>;

/** `ActionHttp.layer`'s options. */
export interface LayerOptions<M extends Middleware = [], A extends Action.Any = never> {
  /**
   * The actions it serves, among the binding's actions the implementations hold: `[GetUser]`.
   * Defaults to every one of them.
   */
  readonly actions?: ReadonlyArray<A> | undefined;
  /**
   * Native endpoint middleware every served route runs, the first innermost: inside the
   * authentication of a protected route, outside its decoding, so it also sees invalid input.
   *
   * **Gotchas**
   *
   * - A middleware requiring the identity needs a layer serving only protected actions: serve the public ones from a second layer without it.
   */
  readonly middleware?: M;
}

type LayerRequest<App, A extends Action.Any, M extends Middleware> = Exclude<
  Through<M, RemoteRequest<App, A>>,
  | HttpRouter.Provided
  | ([Extract<Serving<App, A>, { readonly caller: typeof Anyone }>] extends [never]
      ? Identity<Protected<Serving<App, A>>>
      : never)
>;

/** Contract-level configuration shared by servers and clients. */
export interface Options<E extends Action.Errors = Action.Errors> {
  /**
   * The mount path of every route: `/api` by default, `/` at the root. Split a large API, or
   * actions sharing a name, into one binding per area, each with its own `prefix` and client;
   * one host serves them all.
   */
  readonly prefix?: `/${string}`;
  /**
   * What router middleware around the routes, or the layer's `middleware`, answers with, such as
   * a quota's 429, which every endpoint declares: one schema, or a list.
   *
   * **Gotchas**
   *
   * - An error a handler fails with goes in its action's `error`, not here.
   * - Router middleware answering with one encodes and sends it itself, `HttpServerResponse.schemaJson(QuotaExceeded)(error, { status: 429 })`, at the status `Action.Options.error` gives it: at any other a client fails with an `HttpClientError`.
   */
  readonly error?: E | E[number];
  /**
   * The descriptor of the binding's protected actions, `Authentication.make(...)`: required
   * when it holds one, and it documents and enforces their credentials as native endpoint
   * security middleware on each of them.
   *
   * **Gotchas**
   *
   * - One descriptor per binding: actions of a second identity take a second binding with its own `prefix`, and a public action may be in both.
   */
  readonly authentication?: Authentication;
}

type Endpoint<A extends Action.Any, E extends Action.Errors, D> = A extends Action.Any
  ? HttpApiEndpoint.HttpApiEndpoint<
      A["name"],
      "POST",
      `/${string}`,
      never,
      never,
      Schema.toCodecJson<A["input"]>,
      never,
      Schema.toCodecJson<A["success"]>,
      Schema.toCodecJson<A["error"][number] | E[number] | VerifierError<A, D> | BuiltIns>,
      never
    >
  : never;

type Api<Actions extends ReadonlyArray<Action.Any>, E extends Action.Errors, D> = HttpApi.HttpApi<
  "actions",
  HttpApiGroup.HttpApiGroup<string, Endpoint<Actions[number], E, D>, true>
>;

/**
 * An HTTP binding: actions, the errors every endpoint declares, and where they are mounted.
 * Plain data, so a copy of it, or one made by another installed copy of this package,
 * serves the same; `layer` serves it and `client` calls it.
 */
export interface Binding<
  Actions extends ReadonlyArray<Action.Any>,
  E extends Action.Errors = [],
  D extends Authentication | undefined = undefined,
> {
  /** Its protected actions' authentication descriptor, or `undefined` without one. */
  readonly authentication: D;
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** The errors every endpoint declares besides its action's own, as a list. */
  readonly error: E;
  /** Where its routes mount: `/api` by default, `/` at the root, without a trailing slash. */
  readonly prefix: `/${string}`;
  /**
   * The native `HttpApi`, for `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`
   * and Effect's own tools: it lists every action of the binding, served or not.
   *
   * **Gotchas**
   *
   * - Serve it with `layer`, never the native `HttpApiBuilder`: with a protected action the host then fails to build, with `Service not found: effect-actions/Authentication/Security/…`.
   * - A header that middleware reads is not in its document, whose operations list no `parameters`: rewrite it, `OpenApi.fromApi(Http.api.annotate(OpenApi.Transform, (document) => …))`, or make the value an input.
   * - An OAuth protected resource is documented as a bearer scheme: Effect has no OAuth scheme.
   * - Combined into one document, `HttpApi.make("app").addHttpApi(A.api).addHttpApi(B.api)`, a shared action name makes `OpenApi.fromApi` throw `Duplicate OpenAPI operationId`, and a shared prefix silently drops one binding's actions from the document and a native client: otherwise document each alone.
   * - A binding holding no protected action documents no security scheme, so Swagger shows no Authorize button.
   */
  readonly api: Api<Actions, E, D>;
}

interface Request {
  readonly payload: ErasedValue;
}

const mountSegments = (prefix: `/${string}` | undefined): ReadonlyArray<string> =>
  (prefix ?? "/api").split("/").filter((segment) => segment !== "");

const absolutePath = (segments: ReadonlyArray<string>): `/${string}` => `/${segments.join("/")}`;

const groupName = (mount: ReadonlyArray<string>): string => mount.join("/") || "/";

const apiOf = (group: string, endpoints: ReadonlyArray<HttpApiEndpoint.Constraint>) => {
  const empty = HttpApiGroup.make(group, { topLevel: true });
  const [first, ...rest] = endpoints;

  return HttpApi.make("actions")
    .annotate(HttpApi.ParseOptions, { errors: "all" })
    .add(first === undefined ? empty : empty.add(first, ...rest));
};

// Why: Every route is a POST, a `readOnly` action's included. A GET carries its input in the query
// string, where `HttpApi` takes only fields that encode to strings or arrays of strings, so a
// nested input or a number has no faithful form; and the caching a GET would buy only a public
// `readOnly` action gives up, as a protected route's answers are `no-store`.
const endpointOf = (action: Action.Any, path: `/${string}`, errors: Action.Errors) =>
  HttpApiEndpoint.post(action.name, path, {
    payload: action.input.pipe(HttpApiSchema.asJson()),
    success: action.success,
    error: errors.map(declared),
  });

const withinLayerMiddleware = (endpoint: HttpApiEndpoint.Top, middleware: Middleware = []) =>
  middleware.reduce((inner, key) => inner.middleware(key), endpoint);

// Why: Two forms, actions alone or with options, not one whose options are a conditional rest
// parameter, as `OptionalUnless` gives: through one, TypeScript infers no `const` tuple of `error`,
// which `Certain` needs. The first takes public actions by its constraint, which a helper generic
// in them meets.
/**
 * Bind actions once, for servers and clients alike, each at `POST <prefix>/<action>`, a
 * `readOnly` one too. Every endpoint declares its action's errors, the binding's `error`, and
 * the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`, so clients decode each as a
 * typed failure.
 * Guide: `docs/ActionHttp.md` in this package; in an application: `examples/notes-service/src/routes.ts`.
 */
export function make<
  const Actions extends ReadonlyArray<Action.Any & { readonly caller: typeof Anyone }>,
>(actions: Actions): Binding<Actions, [], undefined>;
export function make<const Actions extends ReadonlyArray<Action.Any>, const O extends Options = {}>(
  actions: Actions,
  options: O &
    RequiredAuthentication<Actions[number]> &
    Matching<Actions[number], NoInfer<DescriptorOf<O>>> &
    NoInfer<Known<O, Options>>,
): Binding<Actions, ErrorsOf<O>, DescriptorOf<O>>;
// Why: Reached only when the forms above fail. TypeScript reports a call matching no overload by
// the last one's error, so this one tells protected actions without options to name their
// authentication, where the first form's constraint would tell them to be public.
export function make<const Actions extends ReadonlyArray<Action.Any>>(
  actions: Actions & PublicOnly<Actions>,
): Binding<Actions, [], undefined>;
export function make(actions: ReadonlyArray<Action.Any>, options: Options = {}): AnyHttp {
  const bound = bindingOf("ActionHttp binding", actions, options);
  const mount = mountSegments(options.prefix);
  const security = bound.authentication?.["~middleware"];

  const endpoints = actions.map((action) => {
    const isPublic = security === undefined || action.caller === Anyone;

    const endpoint = endpointOf(
      action,
      absolutePath([...mount, action.name]),
      bindingErrors(action, bound),
    ).annotate(OpenApi.Description, action.description);

    return isPublic ? endpoint : endpoint.middleware(security);
  });

  const api = apiOf(groupName(mount), endpoints);

  return { actions, ...bound, prefix: absolutePath(mount), api };
}

// Why: `HttpApiBuilder.group` lays the context it is built in over each request's, so a startup
// value would win over a request's own under one tag. Built in an empty context it lays nothing.
// That relies on `group` reading nothing else there: a service it starts to read fails the build,
// but a reference silently takes its default.
const buildInEmptyContext = <A, E>(group: Layer.Layer<A, E>): Layer.Layer<A, E> =>
  Layer.fromBuild((memoMap, scope) =>
    Effect.setContext(Layer.buildWithMemoMap(group, memoMap, scope), Context.empty()),
  );

// Why: Puts the startup context `buildInEmptyContext` withholds beneath each request's, not over
// it. It wraps the whole route rather than the handler, so `HttpApi`'s own error reporting runs
// once, in the merged context.
const startupBeneathRequest = () =>
  HttpRouter.middleware(
    Effect.map(Effect.context<unknown>(), (built) => {
      const startup = Context.omit(Scope.Scope)(built);

      return (route) =>
        Effect.updateContext(route, (current: Context.Context<never>) =>
          Context.merge(startup, current),
        );
    }),
  ).layer;

// Why: A middleware of its own, just inside authentication, answers a step-up refusal. Effect's
// security middleware sees a route's failure only wrapped in a private type, and a refusal recorded
// in the handler, as MCP records it, would override a layer middleware that recovers from it or
// replaces it.
class StepUp extends HttpApiMiddleware.Service<StepUp>()("effect-actions/ActionHttp/StepUp") {}

class JsonContentType extends HttpApiMiddleware.Service<JsonContentType>()(
  "effect-actions/ActionHttp/JsonContentType",
) {}

// Why: Normalized as `HttpApiBuilder` does, its own being internal, so this middleware answers
// every content type the JSON payload would refuse, and its answer says the fix.
const mediaTypeOf = (contentType: string | undefined) =>
  contentType === undefined ? "none" : (contentType.toLowerCase().split(";")[0] ?? "").trim();

const jsonContentType = () =>
  Layer.succeed(JsonContentType, (route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const type = mediaTypeOf(request.headers["content-type"]);

      return type === "application/json"
        ? route
        : Effect.succeed(
            HttpServerResponse.text(`Unsupported content-type: ${type} (send application/json)`, {
              status: 415,
            }),
          );
    }),
  );

/**
 * Serve the binding's actions among `implementations` in one layer, or those its `actions` lists,
 * authenticating a protected action's request before decoding it, then running its
 * implementation's `authorize` before each handler. An implementation's actions the binding
 * leaves out have no route here, one holding none of those served is not built, and a non-empty
 * list holding none of the binding's actions is refused when `layer` is called. Several layers
 * may serve one binding, each with its own `actions` and `middleware` covering its routes only.
 * The layer fails as the builders do, needs at startup what they need, and per request what the
 * authorization and handlers of the actions it serves need, until its `middleware` or middleware
 * around it provides them, the identity of a protected action excepted, which its authentication
 * provides; what is provided per request wins over what the layer was built with. A declared
 * error answers with its JSON at its `httpApiStatus`, 422 without one, as `Action.Options.error`
 * says, input that does not decode a 400 `InvalidInput`, and a refusal as
 * `Action.Unauthenticated` and `Action.Forbidden` say.
 *
 * **Gotchas**
 *
 * - A success is its JSON as the body; an action without `success` answers an empty 200, no body and no content type, so a hand-written client must not parse it. One without `input` still takes the body `{}` typed as JSON: no body is a 400.
 * - A body that is not JSON is a 400 `InvalidInput`; a `Content-Type` missing or not JSON a 415 whose text is `Unsupported content-type: <type> (send application/json)`, `none` without one; both after authentication on a protected route.
 * - A defect, an undeclared failure, or a success or an error that does not encode answers an empty 500: the cause goes to the log and to the call's `ErrorReporter`s, never to the body.
 * - A path no layer serves, or a method other than `POST` on a route, is a 404.
 * - The 415 keeps from every handler what another site's page can send without a CORS preflight, such as a form post carrying the user's cookie; the server's CORS policy decides the rest.
 * - Router middleware providing a request service `X` is declared `HttpRouter.middleware<{ provides: X }>()`: without the type argument it runs and the layer still owes `X`. `HttpRouter.provideRequest(layer)` builds its layer once, at startup, so it never provides an identity or a tenant.
 * - A request body is read whole, however large, unless the host provides `HttpServerRequest.MaxBodySize` to `HttpRouter.serve`, limiting every route it serves, MCP endpoints included. On Node a request over it gets no response, its connection closed, never a 413; `HttpRouter.toWebHandler` ignores it, so limit bodies in the platform serving the handler.
 * - An `ErrorReporter` the server runs with is given, as `Info`, a declared failure of a handler or `authorize` and an input that does not decode, never a refused credential: give an error class `override readonly [ErrorReporter.ignore] = true` to keep it out, and drop `Info` for a built-in error, which takes no mark.
 */
export function layer<const H extends AnyHttp, const Apps extends Served>(
  binding: H,
  implementations: Apps,
): HttpLayer<H, Apps, []>;
export function layer<
  const H extends AnyHttp,
  const Apps extends Served,
  const O extends LayerOptions<Middleware, H["actions"][number]>,
>(
  binding: H,
  implementations: Apps,
  options: O &
    ServerOnly<MiddlewareOf<O, Middleware>, H["error"]> &
    NoInfer<Known<O, LayerOptions<Middleware>>>,
): HttpLayer<H, Apps, MiddlewareOf<O, Middleware>, Selected<O, H["actions"][number]>>;
export function layer(
  binding: AnyHttp,
  served: Served,
  options: LayerOptions<Middleware> = {},
): Layer.Layer<never, unknown, unknown> {
  const { apps, actions, authentication } = servingOf("HTTP binding", binding, served, options);

  const mount = mountSegments(binding.prefix);
  const name = groupName(mount);

  const api = apiOf(
    name,
    actions.map((action) => {
      const endpoint = withinLayerMiddleware(
        // Why: Without the verifier's errors, which `make` declares: the security middleware
        // answers them itself, so a served route never fails with one.
        endpointOf(
          action,
          absolutePath([...mount, action.name]),
          projectedErrors(action, binding.error),
        )
          .middleware(JsonContentType)
          .middleware(SchemaErrors),
        options.middleware,
      );

      return action.caller === Anyone || authentication === undefined
        ? endpoint
        : endpoint.middleware(StepUp).middleware(authentication["~middleware"]);
    }),
  ).annotate(HttpApi.PayloadParseOptions, inputParseOptions);

  const handlers = Layer.unwrap(
    Effect.gen(function* () {
      const bound = yield* acquire(apps);

      const security =
        authentication === undefined
          ? Layer.empty
          : yield* Effect.map(providerOf(authentication), (provider) =>
              Layer.mergeAll(
                Layer.succeed(authentication["~middleware"], provider.middleware),
                Layer.succeed(StepUp, provider.stepUp),
              ),
            );

      const hostProvidedMiddleware = yield* Effect.forEach(options.middleware ?? [], (key) =>
        Effect.map(Effect.service(key), (service) => Layer.succeed(key, service)),
      );

      const byName = Object.fromEntries(
        bound.map(
          ([action, run]) => [action.name, (request: Request) => run(request.payload)] as const,
        ),
      );

      return HttpApiBuilder.group(api, name, (builder) =>
        builder.handleAll(
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint registration boundary: the native router selects the endpoint, and so the action, before its handler runs; `layer`'s signature restores every channel.
          byName as never,
        ),
      ).pipe(
        Layer.provide([schemaErrors(), jsonContentType(), security, ...hostProvidedMiddleware]),
        buildInEmptyContext,
      );
    }),
  ).pipe(provideHandlers(apps));

  return HttpApiBuilder.layer(api).pipe(
    Layer.provide(handlers),
    Layer.provide(startupBeneathRequest()),
  );
}

/**
 * Effect's native `HttpApiClient` for a binding, one method per action taking the
 * action's input directly: `client.greet({ name })`, the argument omitted when `{}` is a valid
 * input. Requires the native `HttpClient`, as `HttpApiClient.make` does; the native client
 * itself stays available: `HttpApiClient.make(Http.api)`. Each call fails with its
 * `MethodError`, an undeclared answer such as a 502 from a proxy or a defect's empty 500 as an
 * `HttpClientError`, and with what `transformClient` adds.
 *
 * **Gotchas**
 *
 * - An input that does not encode fails with `InvalidInput`, and nothing is sent; undeclared input fields, which TypeScript lets through on a wider value, are dropped as it encodes, since the server would refuse them.
 * - It interprets no status and retries nothing: a failed write may have happened, and only a declared error says what the server did.
 */
export function client<const H extends AnyHttp>(
  binding: H,
  options?: ClientOptions,
): Effect.Effect<Client<H>, never, HttpClient.HttpClient>;
export function client<const H extends AnyHttp, E, R>(
  binding: H,
  options: ClientOptions<E, R>,
): Effect.Effect<Client<H, E, R>, never, HttpClient.HttpClient>;
export function client(
  binding: AnyHttp,
  options?: ClientOptions | ClientOptions<unknown, unknown>,
): Effect.Effect<unknown, never, HttpClient.HttpClient> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased implementation: the native client is invariant in what it fails with and requires, so no one type holds both overloads' options; each overload states the channels its own options give.
  return methods(binding, options as ClientOptions<unknown, unknown>);
}

/**
 * `client` built once over `fetch`, for code that holds a client outside an Effect, such as
 * a browser app: its methods are the same Effects, which require only what `transformClient`
 * requires, so a call without one runs alone, as `Effect.runPromise(api.greet({ name }))`. The
 * options are `client`'s, and `fetch`.
 */
export function fetchClient<const H extends AnyHttp>(
  binding: H,
  options?: FetchClientOptions,
): Client<H>;
export function fetchClient<const H extends AnyHttp, E, R>(
  binding: H,
  options: FetchClientOptions<E, R>,
): Client<H, E, R>;
export function fetchClient(
  binding: AnyHttp,
  { fetch, ...options }: FetchClientOptions | FetchClientOptions<unknown, unknown> = {},
): { readonly [name: string]: ErasedMethod } {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased implementation: as `client`'s, each overload states the channels its own options give. Building runs no request, so it needs only the `HttpClient` provided here; what a transform requires, each call requires.
  return methods(binding, options as ClientOptions<unknown, never>).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      fetch ?? ((input, init) => globalThis.fetch(input, init)),
    ),
    Effect.runSync,
  );
}
