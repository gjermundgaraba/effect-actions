import {
  Context,
  Effect,
  type FileSystem,
  Layer,
  type Path,
  Schema,
  SchemaAST,
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
import type * as Action from "./Action.js";
import {
  assertAuthentication,
  type Any as Authentication,
  type Identity,
  type Matching,
  type ServedProvider,
  type RemoteRequest,
  type Required as RequiredAuthentication,
} from "./internal/authentication.js";
import {
  assertDistinct,
  assertOnce,
  assertOwnTags,
  projectedErrors,
  unsuspended,
} from "./internal/actions.js";
import {
  type AnyHttp,
  type Client,
  type ErasedMethod,
  methods,
  type Options as ClientOptions,
} from "./internal/client.js";
import type { BuiltIn, BuiltIns } from "./internal/errors.js";
import { SchemaErrors, schemaErrors } from "./internal/schema-errors.js";
import {
  type Protected,
  acquire,
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type ErasedValue,
  type Known,
  type Member,
  provideHandlers,
  type Served,
  type Serving,
  select,
  type Selected,
  type Holding,
  assertHeld,
  toList,
} from "./internal/implementation.js";

/** A client's methods, one per action of the binding. */
export type { Client } from "./internal/client.js";

/** Any HTTP binding, with its actions erased: what `layer` and `client` read. */
export type { AnyHttp as Any } from "./internal/client.js";

/**
 * The native `HttpApiClient.make` options `client` takes: `baseUrl` and `transformClient`.
 */
export type { Options as ClientOptions } from "./internal/client.js";

/** What `fetchClient` takes: `client`'s options, and the `fetch` its calls send with. */
export interface FetchClientOptions extends ClientOptions {
  /**
   * What each call sends with. Omitted: the global `fetch`, looked up on every call, so one
   * installed after the client is built, such as a test's stub, is used.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/** Error schemas, as an action declares them. */
type Errors = Action.Any["errors"];

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
 * The middleware options `O` install: its `middleware` when always given, an array of unknown
 * length when it may be absent, which installs none or all of them, and none otherwise.
 */
type MiddlewareOf<O> = O extends { readonly middleware: infer M extends Middleware }
  ? M
  : O extends { readonly middleware?: infer M extends Middleware | undefined }
    ? "middleware" extends keyof O
      ? ReadonlyArray<NonNullable<M>[number]>
      : []
    : [];

/**
 * The layer's middleware, refused when one fails with an error neither the binding, `E`, nor
 * every endpoint declares, or needs a client counterpart: neither reaches the binding's
 * clients, which decode only what the binding and the built-ins declare. A failure an
 * action's callers see after decoding is a check's, declared on the contract and decoded by
 * every client.
 */
type ServerOnly<M extends Middleware, E extends Errors> = [
  | Exclude<
      HttpApiMiddleware.Error<IdOf<M[number]>>,
      Extract<Certain<E>, Errors[number]>["Type"] | BuiltIn
    >
  | HttpApiMiddleware.MiddlewareClient<IdOf<M[number]>>,
] extends [never]
  ? unknown
  : {
      readonly "Layer middleware fails only with the binding's errors and needs no client": never;
    };

/** `T` where it is one type, not a union: what a list's slot of type `T` surely holds. */
type Single<T> = true extends Types.IsUnion<T> ? never : T;

/**
 * The errors a binding of errors `E` surely declares: each slot of one error in a list of
 * fixed length, never one of an array of unknown length, which may be empty, nor of a list
 * `E` may be one of several.
 */
type Certain<E extends Errors> =
  true extends Types.IsUnion<E>
    ? never
    : number extends E["length"]
      ? never
      : { readonly [K in keyof E]: Single<E[K]> }[number];

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
  | BuildContext<Holding<Member<Apps>, A>, A>
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

/** What the layer serving `A` of `App` behind middleware `M` owes per request. */
type LayerRequest<App, A extends Action.Any, M extends Middleware> = Exclude<
  Through<M, RemoteRequest<App, A>>,
  | HttpRouter.Provided
  // Authentication, outermost, provides the identity, though only to protected routes.
  | ([Extract<Serving<App, A>, { readonly auth: "public" }>] extends [never]
      ? Identity<Protected<Serving<App, A>>>
      : never)
>;

/**
 * The errors options `O` declare, as at run time: those `errors` always gives, or, where it may
 * be absent, those it gives or none, so clients decode each that may arrive.
 */
type ErrorsOf<O> = O extends unknown
  ? "errors" extends keyof O
    ? O extends { readonly errors: infer E extends Errors }
      ? E
      : Extract<O["errors" & keyof O], Errors> | []
    : []
  : never;

/** Actions a binding takes without options: public ones, as a protected one names its descriptor. */
type PublicOnly<Actions extends ReadonlyArray<Action.Any>> = [
  Exclude<Actions[number], { readonly auth: "public" }>,
] extends [never]
  ? unknown
  : { readonly "Protected actions take options naming their authentication": never };

/** The descriptor options `O` name, where they always name one. */
type DescriptorOf<O> = [O] extends [{ readonly authentication: infer D extends Authentication }]
  ? D
  : undefined;

/** Contract-level configuration shared by servers and clients. */
export interface Options<E extends Errors = Errors> {
  readonly prefix?: `/${string}`;
  readonly errors?: E;
  readonly authentication?: Authentication;
}

type Endpoint<A extends Action.Any, E extends Errors> = A extends Action.Any
  ? HttpApiEndpoint.HttpApiEndpoint<
      A["name"],
      "POST",
      `/${string}`,
      never,
      never,
      Schema.toCodecJson<A["input"]>,
      never,
      Schema.toCodecJson<A["success"]>,
      Schema.toCodecJson<A["errors"][number] | E[number] | BuiltIns>,
      never
    >
  : never;

/**
 * The native `HttpApi` of `Actions`: one top-level group, so native client methods are
 * not nested, named after the binding's mount path, `/` at the root, so bindings composed
 * into one host API keep their own groups.
 */
type Api<Actions extends ReadonlyArray<Action.Any>, E extends Errors> = HttpApi.HttpApi<
  "actions",
  HttpApiGroup.HttpApiGroup<string, Endpoint<Actions[number], E>, true>
>;

/**
 * An HTTP binding: actions, the errors every endpoint declares, and where they are mounted.
 * Plain data, so a copy of it, or one made by another installed copy of this package,
 * serves the same; `layer` serves it and `client` calls it.
 */
export interface Binding<
  Actions extends ReadonlyArray<Action.Any>,
  E extends Errors = [],
  D extends Authentication | undefined = undefined,
> {
  readonly authentication: D;
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** The errors every endpoint declares besides its action's own. */
  readonly errors: E;
  /** Where its routes mount: `/api` by default, `/` at the root, without a trailing slash. */
  readonly prefix: `/${string}`;
  readonly api: Api<Actions, E>;
}

/** A native request, as `HttpApiBuilder.handleAll` passes it to a handler. */
interface Request {
  readonly payload: ErasedValue;
}

/** The mount path's segments: `api` by default; none for `/`. */
const mountSegments = (prefix: `/${string}` | undefined): ReadonlyArray<string> =>
  (prefix ?? "/api").split("/").filter((segment) => segment !== "");

/** An absolute route from path segments. */
const route = (segments: ReadonlyArray<string>): `/${string}` => `/${segments.join("/")}`;

/**
 * The name of a binding's one native group: its OpenAPI tag, by which the native `addHttpApi`
 * keys groups. It is the mount path, `/` at the root, which no segment contains.
 */
const groupName = (mount: ReadonlyArray<string>): string => mount.join("/") || "/";

/** A native API of one top-level group of `endpoints`. */
const apiOf = (group: string, endpoints: ReadonlyArray<HttpApiEndpoint.Constraint>) => {
  const empty = HttpApiGroup.make(group, { topLevel: true });
  const [first, ...rest] = endpoints;

  return HttpApi.make("actions")
    .annotate(HttpApi.ParseOptions, { errors: "all" })
    .add(first === undefined ? empty : empty.add(first, ...rest));
};

/**
 * `apps` narrowed to the actions the layer serves, matched by identity: those `listed`, which
 * the binding must hold, or every one of the binding's they hold, each once. An
 * implementation holding none of them is left out, and not built. Implementations holding
 * none of the binding's actions are refused, as the wrong implementations or the wrong
 * binding; a name the binding holds is marked as another contract's, as a second copy of the
 * contracts module makes one.
 */
const servedBy = (
  http: AnyHttp,
  apps: ReadonlyArray<AnyImplementation>,
  listed: ReadonlyArray<Action.Any> | undefined,
): ReadonlyArray<AnyImplementation> => {
  if (listed !== undefined) assertHeld("the binding does not hold it", listed, http.actions);

  const held = apps.flatMap((app) => app.actions);
  const served = select(apps, listed ?? http.actions.filter((action) => held.includes(action)));
  const actions = served.flatMap((app) => app.actions);

  if (actions.length === 0 && listed === undefined && apps.length > 0) {
    const bound = new Set(http.actions.map(({ name }) => name));

    throw new Error(
      `No action of these implementations is in this HTTP binding: ${
        held
          .map(({ name }) => (bound.has(name) ? `${name} (another contract)` : name))
          .join(", ") || "none"
      }`,
    );
  }

  assertOnce("served action", actions);

  return served;
};

/** The status an error schema states, as `HttpApi` reads it. */
const statusOf = SchemaAST.resolveAt<number>("httpApiStatus");

/** The status a schema states, or the first one a suspension it wraps states. */
const statusThrough = (ast: SchemaAST.AST): number | undefined =>
  statusOf(ast) ?? (SchemaAST.isSuspend(ast) ? statusThrough(ast.thunk()) : undefined);

type Declared = Action.Any["errors"][number];

/**
 * The schemas an endpoint declares for one error, each with the status it is sent with. `HttpApi`
 * reads a status off each declared schema, never off a union's members nor through a suspension, so
 * a plain union without a status of its own declares each member, and a suspended error, as a
 * recursive one is written, without a status of its own states the status of what it suspends. An
 * error without a status is an outcome the action expects, not a server fault: it is sent as 422,
 * rather than `HttpApi`'s 500, which clients and proxies read as the server failing.
 */
const declared = (error: Declared): ReadonlyArray<Declared> => {
  const status = statusThrough(error.ast);

  if (status !== undefined) {
    return [statusOf(error.ast) === undefined ? HttpApiSchema.status(status)(error) : error];
  }

  const resolved = unsuspended(error.ast);

  if (
    SchemaAST.isUnion(resolved) &&
    resolved.checks === undefined &&
    resolved.encoding === undefined
  ) {
    return resolved.types.flatMap((member) => declared(Schema.make<Declared>(member)));
  }

  return [HttpApiSchema.status(422)(error)];
};

/**
 * The native endpoint of `action` at `path`, declaring its action's errors, the binding's
 * `errors` and the built-in ones: what `make` documents and `layer` serves. Its payload is
 * JSON whatever encoding the input is annotated with, which no other surface reads either:
 * `HttpApi` would take a form or text body for it, which a page sends without a preflight.
 */
const endpointOf = (action: Action.Any, path: `/${string}`, errors: Errors) =>
  HttpApiEndpoint.post(action.name, path, {
    payload: action.input.pipe(HttpApiSchema.asJson()),
    success: action.success,
    error: projectedErrors(action, errors).flatMap(declared),
  });

/** An endpoint wrapped in a layer's middleware, the first innermost. */
const within = (endpoint: HttpApiEndpoint.Top, middleware: Middleware = []) =>
  middleware.reduce((inner, key) => inner.middleware(key), endpoint);

/**
 * Bind actions once, for servers and clients alike, each at `POST <prefix>/<action>`.
 * Every endpoint declares its action's errors, the binding's `errors`, and the built-in
 * `InvalidInput`, `Unauthenticated` and `Forbidden`, so clients decode each as a typed
 * failure. A union's own `httpApiStatus` applies to every member; otherwise, each member
 * uses its own status, or 422 without one. Protected contracts receive native endpoint
 * security middleware: the same descriptor documents their credentials and enforces them.
 */
// Two forms, not one with a conditional rest parameter, through which TypeScript infers no
// `const` tuple of errors; and so explicit options naming errors require the argument. The
// first takes public actions by its constraint, which a helper generic in them meets.
export function make<const Actions extends ReadonlyArray<Action.Any & { readonly auth: "public" }>>(
  actions: Actions,
): Binding<Actions, [], undefined>;
export function make<const Actions extends ReadonlyArray<Action.Any>, const O extends Options = {}>(
  actions: Actions,
  options: O &
    RequiredAuthentication<Actions[number]> &
    Matching<Actions[number], NoInfer<DescriptorOf<O>>> &
    NoInfer<Known<O, Options>>,
): Binding<Actions, ErrorsOf<O>, DescriptorOf<O>>;
// Last, and reached only when the forms above fail: TypeScript reports a call matching no
// overload by the last one's error alone, so protected actions without options are told to
// name their authentication, rather than to be public.
export function make<const Actions extends ReadonlyArray<Action.Any>>(
  actions: Actions & PublicOnly<Actions>,
): Binding<Actions, [], undefined>;
export function make(actions: ReadonlyArray<Action.Any>, options: Options = {}): AnyHttp {
  assertOnce("action", actions);

  const errors = options.errors ?? [];

  assertOwnTags("ActionHttp binding", errors);

  assertAuthentication(actions, options.authentication);

  const mount = mountSegments(options.prefix);
  const security = options.authentication?.["~middleware"];

  const endpoints = actions.map((action) => {
    const endpoint = endpointOf(action, route([...mount, action.name]), errors).annotate(
      OpenApi.Description,
      action.description,
    );

    return security === undefined || action.auth === "public"
      ? endpoint
      : endpoint.middleware(security);
  });

  // The one native group is top level, so its client methods are not nested. Named after
  // the mount path, two bindings on different prefixes combine side by side, when no action
  // name, and so no operation ID, repeats across them.
  const api = apiOf(groupName(mount), endpoints);

  return {
    actions,
    errors,
    prefix: route(mount),
    api,
    authentication: options.authentication,
  };
}

/**
 * `group`, built in an empty context rather than the one around it: `HttpApiBuilder` lays
 * the context a group is built in over every request's, where a startup value would replace
 * what middleware provides for the request. `entry` puts that context beneath it instead.
 */
const buildAlone = <A, E>(group: Layer.Layer<A, E>): Layer.Layer<A, E> =>
  Layer.fromBuild((memoMap, scope) =>
    Effect.setContext(Layer.buildWithMemoMap(group, memoMap, scope), Context.empty()),
  );

/**
 * Restore startup dependencies beneath request context, so a caller's services win.
 */
const entry = () =>
  HttpRouter.middleware(
    Effect.map(Effect.context<unknown>(), (built) => {
      // Never the layer's scope: a route runs in its request's, and each call in its own.
      const startup = Context.omit(Scope.Scope)(built);

      return (route) =>
        Effect.updateContext(route, (current: Context.Context<never>) =>
          Context.merge(startup, current),
        );
    }),
  ).layer;

/**
 * Answers a protected route's step-up refusal, as it leaves the layer's middleware, with its
 * challenge: the provider's `stepUp`, inside the authentication.
 */
class StepUp extends HttpApiMiddleware.Service<StepUp>()("effect-actions/ActionHttp/StepUp") {}

/** Require JSON media typing after endpoint authentication, before payload decoding. */
class JsonContentType extends HttpApiMiddleware.Service<JsonContentType>()(
  "effect-actions/ActionHttp/JsonContentType",
) {}

const jsonContentType = Layer.succeed(JsonContentType, (route) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    request.headers["content-type"] === undefined
      ? Effect.succeed(HttpServerResponse.text("Unsupported content-type: none", { status: 415 }))
      : route,
  ),
);

/**
 * Serve the binding's actions among `implementations` in one layer, or those its `actions` lists,
 * authenticating a protected action's request before decoding it, then running its implementation's
 * `authorize` and its declared checks before each handler. The binding decides what may be served:
 * an implementation's actions the binding leaves out have no route here, and one holding none of
 * those served is not built; implementations holding none of the binding's actions at all are
 * refused when `layer` is called. It mounts only the routes of the actions it serves, so one
 * binding may be served by several layers, each with its own `actions` and `middleware`, which
 * covers its routes only. Each implementation's builder runs once per layer graph however many
 * layers serve it.
 *
 * The layer fails as the builders do, needs at startup what they need, and per request what
 * each implementation's authorization, the checks and the handlers of the actions it serves
 * need, until its `middleware` or middleware provided around it provides them, the identity
 * of a protected action excepted, which its authentication provides; the router provides
 * its own, such as the request, to every route. Its routes take only requests typed as JSON,
 * and what middleware provides per request wins over what the layer was built with.
 */
export function layer<const H extends AnyHttp, const Apps extends Served>(
  http: H,
  implementations: Apps,
): HttpLayer<H, Apps, []>;
// Options apart, so the middleware or actions an options type names are never typed as
// installed or selected where the options are left out.
export function layer<
  const H extends AnyHttp,
  const Apps extends Served,
  const O extends LayerOptions<Middleware, H["actions"][number]>,
>(
  http: H,
  implementations: Apps,
  options: O &
    ServerOnly<MiddlewareOf<O>, H["errors"]> &
    NoInfer<Known<O, LayerOptions<Middleware>>>,
): HttpLayer<H, Apps, MiddlewareOf<O>, Selected<O, H["actions"][number]>>;
export function layer(
  http: AnyHttp,
  served: Served,
  options: LayerOptions<Middleware> = {},
): Layer.Layer<never, unknown, unknown> {
  const apps = servedBy(http, toList(served), options.actions);
  const actions = apps.flatMap((app) => app.actions);
  assertAuthentication(actions, http.authentication);
  // Native endpoints keep a middleware's first occurrence only, which the types cannot follow.
  assertDistinct("middleware", options.middleware ?? [], (key) => key.key);

  const mount = mountSegments(http.prefix);
  const name = groupName(mount);

  // Reuse each contract's security descriptor while adding server-only decoding policy.
  // A client drops excess payload fields when encoding; the server rejects them.
  const api = apiOf(
    name,
    actions.map((action) => {
      // Applied innermost first: the layer's middleware runs inside the authentication and
      // its step-up answer, and outside the content type and schema checks.
      const endpoint = within(
        endpointOf(action, route([...mount, action.name]), http.errors)
          .middleware(JsonContentType)
          .middleware(SchemaErrors),
        options.middleware,
      );

      return action.auth === "public" || http.authentication === undefined
        ? endpoint
        : endpoint.middleware(StepUp).middleware(http.authentication["~middleware"]);
    }),
  ).annotate(HttpApi.PayloadParseOptions, { errors: "all", onExcessProperty: "error" });

  const handlers = Layer.unwrap(
    Effect.gen(function* () {
      const bound = yield* acquire(apps);

      const auth = actions.some((action) => action.auth !== "public")
        ? http.authentication
        : undefined;

      const authentication =
        auth === undefined
          ? Layer.empty
          : yield* Effect.map(auth["~provider"], (provider) =>
              Layer.mergeAll(
                Layer.succeed(auth["~middleware"], provider.middleware),
                Layer.succeed(StepUp, provider.stepUp),
              ),
            );

      // The group is built alone, so the layer's middleware is read here, as the host
      // provides it, and handed to the group.
      const middleware = yield* Effect.forEach(options.middleware ?? [], (key) =>
        Effect.map(Effect.service(key), (service) => Layer.succeed(key, service)),
      );

      // Own properties, so an action named `__proto__` is a route, not a prototype.
      const byName = Object.fromEntries(
        bound.map(
          ([action, run]) => [action.name, (request: Request) => run(request.payload)] as const,
        ),
      );

      return HttpApiBuilder.group(api, name, (builder) =>
        builder.handleAll(
          // SAFETY: the native router selects the endpoint, and so the action, before
          // its handler runs; `layer`'s signature restores every channel.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint registration boundary.
          byName as never,
        ),
      ).pipe(
        Layer.provide([schemaErrors, jsonContentType, authentication, ...middleware]),
        buildAlone,
      );
    }),
  ).pipe(provideHandlers(apps));

  return HttpApiBuilder.layer(api).pipe(Layer.provide(handlers), Layer.provide(entry()));
}

/** A binding's client, erased: `client` and `fetchClient` restore its exact type. */
const erasedClient = (
  http: AnyHttp,
  options?: ClientOptions,
): Effect.Effect<{ readonly [name: string]: ErasedMethod }, never, HttpClient.HttpClient> =>
  Effect.map(methods(http, options), (methodOf) =>
    Object.fromEntries(http.actions.map((action) => [action.name, methodOf(action)])),
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
  http: H,
  options?: ClientOptions,
): Effect.Effect<Client<H>, never, HttpClient.HttpClient>;
export function client(
  http: AnyHttp,
  options?: ClientOptions,
): Effect.Effect<{ readonly [name: string]: ErasedMethod }, never, HttpClient.HttpClient> {
  return erasedClient(http, options);
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
  http: H,
  options?: FetchClientOptions,
): Client<H>;
export function fetchClient(
  http: AnyHttp,
  { fetch, ...options }: FetchClientOptions = {},
): { readonly [name: string]: ErasedMethod } {
  return erasedClient(http, options).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      fetch ?? ((input, init) => globalThis.fetch(input, init)),
    ),
    Effect.runSync,
  );
}
