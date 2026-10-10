import {
  Context,
  Effect,
  type FileSystem,
  Layer,
  type Path,
  Schema,
  Scope,
  type Types,
} from "effect";
import type { Etag, HttpClient, HttpPlatform } from "effect/http";
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
  assertAuthentication,
  type Any as Authentication,
  type DescriptorOf,
  type Identity,
  type Matching,
  providerOf,
  type PublicOnly,
  type ServedProvider,
  type RemoteRequest,
  type Required as RequiredAuthentication,
  type VerifierError,
} from "../authentication/provider.js";
import {
  Anyone,
  assertDistinct,
  assertOnce,
  assertOwnTags,
  type Certain,
  errorList,
  type ErrorsOf,
  projectedErrors,
} from "../contract/rules.js";
import { declared } from "./declared.js";
import type { ErasedMethod } from "../contract/call.js";
import { type AnyHttp, type Client, methods, type Options as ClientOptions } from "./client.js";
import type { BuiltIn, BuiltIns } from "../contract/errors.js";
import { SchemaErrors, schemaErrors } from "./schema-errors.js";
import {
  type Protected,
  acquire,
  type BuildServices,
  type BuildError,
  type ErasedValue,
  type Known,
  type Member,
  type MiddlewareOf,
  provideHandlers,
  type Served,
  servedBy,
  type Serving,
  type Selected,
  type Holding,
  toList,
} from "../contract/implementation.js";

export type { Client } from "./client.js";

export type { MethodError } from "./client.js";

export type { AnyHttp as Any } from "./client.js";

export type { Options as ClientOptions } from "./client.js";

/** What `fetchClient` takes: `client`'s options, and the `fetch` its calls send with. */
export interface FetchClientOptions extends ClientOptions {
  /**
   * What each call sends with. Omitted: the global `fetch`, looked up on every call, so one
   * installed after the client is built, such as a test's stub, is used.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/** Native endpoint middleware, as `HttpApiMiddleware.Service` declares it. */
type Middleware = ReadonlyArray<Context.Key<HttpApiMiddleware.AnyId, unknown>>;

/** The identifier a middleware's service key declares. */
type IdOf<K> = K extends Context.Key<infer I extends HttpApiMiddleware.AnyId, unknown> ? I : never;

/**
 * What the request owes past the middleware `M`, the first innermost, around what `R` owes:
 * each removes what it provides and adds what it requires, as native endpoints apply them.
 * An array of unknown length, which may hold none of them, provides nothing and owes what
 * any of them requires; so does a slot that may hold one of several, as only one runs.
 */
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

/**
 * The layer's middleware, refused when one fails with an error neither the binding, `E`, nor
 * every endpoint declares, or needs a client counterpart: neither reaches the binding's
 * clients, which decode only what the binding and the built-ins declare. A failure an
 * action's callers see after decoding is its handler's, declared on the contract and decoded
 * by every client.
 */
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

/**
 * The layer serving the actions `A` of `Apps` through the binding `H`, behind the middleware
 * `M`: an implementation holding none of them is not built.
 */
type HttpLayer<
  H extends AnyHttp,
  Apps extends Served,
  M extends Middleware,
  A extends Action.Any = H["actions"][number],
> = Layer.Layer<
  never,
  BuildError<Holding<Member<Apps>, A>, A>,
  | BuildServices<Holding<Member<Apps>, A>, A>
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
   * Defaults to every one of them. A layer whose middleware requires the identity lists
   * protected actions only.
   */
  readonly actions?: ReadonlyArray<A> | undefined;
  /**
   * Native endpoint middleware every served route runs, the first innermost: inside the
   * authentication of a protected route, outside its decoding. A middleware requiring the
   * identity needs a layer serving only protected actions.
   */
  readonly middleware?: M;
}

/**
 * What the layer serving `A` of `App` behind middleware `M` owes per request, less what the
 * router provides and, where every action served is protected, the identity authentication
 * provides, outermost.
 */
type LayerRequest<App, A extends Action.Any, M extends Middleware> = Exclude<
  Through<M, RemoteRequest<App, A>>,
  | HttpRouter.Provided
  | ([Extract<Serving<App, A>, { readonly caller: typeof Anyone }>] extends [never]
      ? Identity<Protected<Serving<App, A>>>
      : never)
>;

/** Contract-level configuration shared by servers and clients. */
export interface Options<E extends Action.Errors = Action.Errors> {
  readonly prefix?: `/${string}`;
  /** Router middleware's errors, which every endpoint declares: one schema, or a list. */
  readonly error?: E | E[number];
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

/**
 * The native `HttpApi` of `Actions`: one top-level group, so native client methods are
 * not nested, named after the binding's mount path, `/` at the root, so bindings composed
 * into one host API keep their own groups.
 */
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
  readonly authentication: D;
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** The errors every endpoint declares besides its action's own, as a list. */
  readonly error: E;
  /** Where its routes mount: `/api` by default, `/` at the root, without a trailing slash. */
  readonly prefix: `/${string}`;
  readonly api: Api<Actions, E, D>;
}

/** A native request, as `HttpApiBuilder.handleAll` passes it to a handler. */
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

const endpointOf = (action: Action.Any, path: `/${string}`, errors: Action.Errors) =>
  HttpApiEndpoint.post(action.name, path, {
    payload: action.input.pipe(HttpApiSchema.asJson()),
    success: action.success,
    error: projectedErrors(action, errors).flatMap(declared),
  });

const withinLayerMiddleware = (endpoint: HttpApiEndpoint.Top, middleware: Middleware = []) =>
  middleware.reduce((inner, key) => inner.middleware(key), endpoint);

/**
 * Bind actions once, for servers and clients alike, each at `POST <prefix>/<action>`.
 * Every endpoint declares its action's errors, the binding's `errors`, and the built-in
 * `InvalidInput`, `Unauthenticated` and `Forbidden`, so clients decode each as a typed
 * failure. A union's own `httpApiStatus` applies to every member; otherwise, each member
 * uses its own status, or 422 without one. Protected contracts receive native endpoint
 * security middleware: the same descriptor documents their credentials and enforces them.
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
export function make<const Actions extends ReadonlyArray<Action.Any>>(
  actions: Actions & PublicOnly<Actions>,
): Binding<Actions, [], undefined>;
export function make(actions: ReadonlyArray<Action.Any>, options: Options = {}): AnyHttp {
  assertOnce("action", actions);

  const errors = errorList(options.error);

  assertOwnTags("ActionHttp binding", errors);

  assertAuthentication(actions, options.authentication);

  const mount = mountSegments(options.prefix);
  const security = options.authentication?.["~middleware"];

  const protectedEndpointVerifierErrors = options.authentication?.error ?? [];

  const endpoints = actions.map((action) => {
    const isPublic = security === undefined || action.caller === Anyone;

    const endpoint = endpointOf(
      action,
      absolutePath([...mount, action.name]),
      isPublic ? errors : [...errors, ...protectedEndpointVerifierErrors],
    ).annotate(OpenApi.Description, action.description);

    return isPublic ? endpoint : endpoint.middleware(security);
  });

  const api = apiOf(groupName(mount), endpoints);

  return {
    actions,
    error: errors,
    prefix: absolutePath(mount),
    api,
    authentication: options.authentication,
  };
}

const buildInEmptyContext = <A, E>(group: Layer.Layer<A, E>): Layer.Layer<A, E> =>
  Layer.fromBuild((memoMap, scope) =>
    Effect.setContext(Layer.buildWithMemoMap(group, memoMap, scope), Context.empty()),
  );

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

class StepUp extends HttpApiMiddleware.Service<StepUp>()("effect-actions/ActionHttp/StepUp") {}

class JsonContentType extends HttpApiMiddleware.Service<JsonContentType>()(
  "effect-actions/ActionHttp/JsonContentType",
) {}

const jsonContentType = () =>
  Layer.succeed(JsonContentType, (route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      request.headers["content-type"] === undefined
        ? Effect.succeed(HttpServerResponse.text("Unsupported content-type: none", { status: 415 }))
        : route,
    ),
  );

/**
 * Serve the binding's actions among `implementations` in one layer, or those its `actions` lists,
 * authenticating a protected action's request before decoding it, then running its implementation's
 * `authorize` before each handler. The binding decides what may be served:
 * an implementation's actions the binding leaves out have no route here, and one holding none of
 * those served is not built; implementations holding none of the binding's actions at all are
 * refused when `layer` is called. It mounts only the routes of the actions it serves, so one
 * binding may be served by several layers, each with its own `actions` and `middleware`, which
 * covers its routes only. Each implementation's builder runs once per layer graph however many
 * layers serve it.
 *
 * The layer fails as the builders do, needs at startup what they need, and per request what
 * each implementation's authorization and the handlers of the actions it serves
 * need, until its `middleware` or middleware provided around it provides them, the identity
 * of a protected action excepted, which its authentication provides; the router provides
 * its own, such as the request, to every route. Its routes take only requests typed as JSON,
 * and what middleware provides per request wins over what the layer was built with.
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
  const apps = servedBy("HTTP binding", binding.actions, toList(served), options.actions);
  const actions = apps.flatMap((app) => app.actions);
  assertAuthentication(actions, binding.authentication);
  assertDistinct("middleware", options.middleware ?? [], (key) => key.key);

  const mount = mountSegments(binding.prefix);
  const name = groupName(mount);

  const api = apiOf(
    name,
    actions.map((action) => {
      const endpoint = withinLayerMiddleware(
        endpointOf(action, absolutePath([...mount, action.name]), binding.error)
          .middleware(JsonContentType)
          .middleware(SchemaErrors),
        options.middleware,
      );

      return action.caller === Anyone || binding.authentication === undefined
        ? endpoint
        : endpoint.middleware(StepUp).middleware(binding.authentication["~middleware"]);
    }),
  ).annotate(HttpApi.PayloadParseOptions, { errors: "all", onExcessProperty: "error" });

  const handlers = Layer.unwrap(
    Effect.gen(function* () {
      const bound = yield* acquire(apps);

      const auth = actions.some((action) => action.caller !== Anyone)
        ? binding.authentication
        : undefined;

      const authentication =
        auth === undefined
          ? Layer.empty
          : yield* Effect.map(providerOf(auth), (provider) =>
              Layer.mergeAll(
                Layer.succeed(auth["~middleware"], provider.middleware),
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
        Layer.provide([
          schemaErrors(),
          jsonContentType(),
          authentication,
          ...hostProvidedMiddleware,
        ]),
        buildInEmptyContext,
      );
    }),
  ).pipe(provideHandlers(apps));

  return HttpApiBuilder.layer(api).pipe(
    Layer.provide(handlers),
    Layer.provide(startupBeneathRequest()),
  );
}

const erasedClient = (
  binding: AnyHttp,
  options?: ClientOptions,
): Effect.Effect<{ readonly [name: string]: ErasedMethod }, never, HttpClient.HttpClient> =>
  Effect.map(methods(binding, options), (methodOf) =>
    Object.fromEntries(binding.actions.map((action) => [action.name, methodOf(action)])),
  );

/**
 * Effect's native `HttpApiClient` for a binding, one method per action taking the
 * action's input directly: `client.greet({ name })`. The argument may be omitted when `{}`
 * is a valid input. Requires the native `HttpClient`, as `HttpApiClient.make` does.
 * The options are the native ones, `baseUrl` and `transformClient`. The native client
 * itself stays available: `HttpApiClient.make(Http.api)`.
 *
 * A call fails with a declared error value (the action's own, or a built-in
 * `InvalidInput`, `Unauthenticated` or `Forbidden`), a native `HttpClientError` when the
 * server could not be reached or answered with a status or body the contract does not
 * declare, or a `SchemaError` when the input does not encode or the success does not
 * decode.
 */
export function client<const H extends AnyHttp>(
  binding: H,
  options?: ClientOptions,
): Effect.Effect<Client<H>, never, HttpClient.HttpClient>;
export function client(
  binding: AnyHttp,
  options?: ClientOptions,
): Effect.Effect<{ readonly [name: string]: ErasedMethod }, never, HttpClient.HttpClient> {
  return erasedClient(binding, options);
}

/**
 * `client` built once over `fetch`, for code that holds a client outside an Effect, such as
 * a browser app: its methods are the same Effects and require nothing, so each call runs
 * alone, as `Effect.runPromise(api.greet({ name }))`. The options are `client`'s, and
 * `fetch`.
 *
 * Each call sends with `options.fetch`, or with the global `fetch` as it is when the call
 * runs.
 */
export function fetchClient<const H extends AnyHttp>(
  binding: H,
  options?: FetchClientOptions,
): Client<H>;
export function fetchClient(
  binding: AnyHttp,
  { fetch, ...options }: FetchClientOptions = {},
): { readonly [name: string]: ErasedMethod } {
  return erasedClient(binding, options).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      fetch ?? ((input, init) => globalThis.fetch(input, init)),
    ),
    Effect.runSync,
  );
}
