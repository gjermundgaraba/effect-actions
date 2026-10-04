import {
  Context,
  Effect,
  type FileSystem,
  Layer,
  type Path,
  Schema,
  SchemaAST,
  Scope,
} from "effect";
import type { Etag, HttpClient, HttpPlatform } from "effect/http";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  type HttpApiSecurity,
  OpenApi,
} from "effect/http-api";
import type * as Action from "./Action.js";
import { assertBindingErrors, assertOnce, projectedErrors } from "./internal/actions.js";
import {
  type AnyHttp,
  type Client,
  type ErasedMethod,
  methods,
  type Options as ClientOptions,
} from "./internal/client.js";
import type { BuiltIns } from "./internal/errors.js";
import { recordStepUp } from "./internal/refusal.js";
import { SchemaErrors, schemaErrors } from "./internal/schema-errors.js";
import {
  acquire,
  type ActionOf,
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type ErasedValue,
  type Member,
  provideHandlers,
  type RequestOf,
  type Served,
  toList,
  uniqueKey,
} from "./internal/implementation.js";

/** A client's methods, one per action of the binding. */
export type { Client } from "./internal/client.js";

/** Any HTTP binding, with its actions erased: what `layer` and `client` read. */
export type { AnyHttp as Any } from "./internal/client.js";

/**
 * The native `HttpApiClient.make` options `client` takes: `baseUrl` and `transformClient`.
 */
export type { Options as ClientOptions } from "./internal/client.js";

/** Error schemas, as an action declares them. */
type Errors = Action.Any["errors"];

/** Native security schemes, keyed by the name the OpenAPI document gives each. */
type Security = Readonly<Record<string, HttpApiSecurity.HttpApiSecurity>>;

/** Contract-level configuration: servers and clients must agree on it. */
export interface Options<E extends Errors = Errors, A extends Action.Any = Action.Any> {
  /** Mount path of every route; defaults to `/api`. `/` mounts at the root. */
  readonly prefix?: `/${string}`;
  /**
   * Errors every endpoint may answer with besides its action's own, such as a limit
   * middleware around the routes applies before decoding: declared by every endpoint, so
   * clients decode them. Handlers and hooks never fail with them; they are the binding's, and
   * no other surface declares them. None shares a `_tag` with a built-in error or an action's.
   */
  readonly errors?: E;
  /**
   * The credentials the authentication around the routes reads, as Effect's native schemes
   * keyed by the name OpenAPI gives each: `{ bearer: HttpApiSecurity.bearer }`. The document
   * states them on every endpoint but `public`'s, any one of them sufficing, and
   * `OpenApi.fromApi`, Swagger and Scalar show them. Documentation only: it enforces nothing,
   * and `layer` serves every endpoint without it. The authentication provided around a layer
   * alone decides who is admitted.
   */
  readonly security?: Security;
  /**
   * The actions served without that authentication, such as a status check: their endpoints
   * state no security requirement. Each must be one of the binding's actions; without
   * `security`, it changes nothing.
   */
  readonly public?: ReadonlyArray<A>;
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

/** The actions of the implementations `App`. */
type ActionsOf<App> = Extract<ActionOf<App>, Action.Any>;

/**
 * The actions of `App` a layer of the binding's actions `Bound` serves: those the binding
 * holds. An implementation whose actions are erased may hold any, so all of them count.
 */
type Serving<App, Bound extends Action.Any> = string extends ActionsOf<App>["name"]
  ? ActionsOf<App>
  : Extract<ActionsOf<App>, Bound>;

/**
 * What each implementation among `App` owes per request where a layer of the actions `Bound`
 * serves it: its hook's services, and the handlers' of the actions it serves.
 */
type ServedRequest<App, Bound extends Action.Any> = App extends unknown
  ? RequestOf<App, Serving<App, Bound>>
  : never;

/**
 * An HTTP binding: actions, the errors every endpoint declares, and where they are mounted.
 * Plain data, so a copy of it, or one made by another installed copy of this package,
 * serves the same; `layer` serves it and `client` calls it.
 */
export interface Binding<Actions extends ReadonlyArray<Action.Any>, E extends Errors = []> {
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
 * The actions of `apps` the binding holds, matched by identity, each once: an
 * implementation's other actions are not this binding's to serve, nor their names to check.
 * An implementation holding none is refused, as the wrong implementation or the wrong
 * binding; a name the binding holds is marked as another contract's, as a second copy of the
 * contracts module makes one.
 */
const servedBy = (
  http: AnyHttp,
  apps: ReadonlyArray<AnyImplementation>,
): ReadonlyArray<Action.Any> => {
  const bound = new Set(http.actions.map(({ name }) => name));

  const served = apps.flatMap((app) => {
    const own = app.actions.filter((action) => http.actions.includes(action));

    if (own.length === 0) {
      const held = app.actions.map(({ name }) =>
        bound.has(name) ? `${name} (another contract)` : name,
      );

      throw new Error(
        `No action of this implementation is in this HTTP binding: ${held.join(", ") || "none"}`,
      );
    }

    return own;
  });

  assertOnce("served action", served);

  return served;
};

/** The status an error schema states, as `HttpApi` reads it. */
const statusOf = SchemaAST.resolveAt<number>("httpApiStatus");

type Declared = Action.Any["errors"][number];

/**
 * The schemas an endpoint declares for one error, each with the status it is sent with.
 * `HttpApi` reads a status off each declared schema, never off a union's members, so a
 * plain union without a status of its own declares each member. An error without a status
 * is an outcome the action expects, not a server fault: it is sent as 422, rather than
 * `HttpApi`'s 500, which clients and proxies read as the server failing.
 */
const declared = (error: Declared): ReadonlyArray<Declared> => {
  const { ast } = error;

  if (statusOf(ast) !== undefined) return [error];

  if (SchemaAST.isUnion(ast) && ast.checks === undefined && ast.encoding === undefined) {
    return ast.types.flatMap((member) => declared(Schema.make<Declared>(member)));
  }

  return [HttpApiSchema.status(422)(error)];
};

/**
 * The native endpoint of `action` at `path`, declaring its action's errors, the binding's
 * `errors` and the built-in ones: what `make` documents and `layer` serves.
 */
const endpointOf = (action: Action.Any, path: `/${string}`, errors: Errors) =>
  HttpApiEndpoint.post(action.name, path, {
    payload: action.input,
    success: action.success,
    error: projectedErrors(action, errors).flatMap(declared),
  });

/**
 * Native security middleware stating `schemes` on the endpoints it is added to, which is
 * how `OpenApi.fromApi` documents a scheme, under a key of each binding's own; none for no
 * scheme. It documents only: `layer` serves its endpoints without it.
 */
const documentation = (schemes: Security) =>
  Object.keys(schemes).length === 0
    ? undefined
    : HttpApiMiddleware.Service<never>()(`effect-actions/ActionHttp/Security/${uniqueKey()}`, {
        security: schemes,
      });

/**
 * Bind actions once, for servers and clients alike, each at `POST <prefix>/<action>`.
 * Every endpoint declares its action's errors, the binding's `errors`, and the built-in
 * `InvalidInput`, `Unauthenticated` and `Forbidden`, so clients decode each as a typed
 * failure. A union's own `httpApiStatus` applies to every member; otherwise, each member
 * of a plain union uses its own status, or 422 without one. `security` documents what the
 * authentication around the routes reads, on every endpoint but `public`'s.
 */
export function make<const Actions extends ReadonlyArray<Action.Any>, const E extends Errors = []>(
  actions: Actions,
  options?: Options<E, Actions[number]>,
): Binding<Actions, E>;
export function make(actions: ReadonlyArray<Action.Any>, options: Options = {}): AnyHttp {
  assertOnce("action", actions);

  const errors = options.errors ?? [];

  assertBindingErrors(actions, errors);

  const open = options.public ?? [];

  const mount = mountSegments(options.prefix);
  const security = documentation(options.security ?? {});

  const endpoints = actions.map((action) => {
    const endpoint = endpointOf(action, route([...mount, action.name]), errors).annotate(
      OpenApi.Description,
      action.description,
    );

    return security === undefined || open.includes(action)
      ? endpoint
      : endpoint.middleware(security);
  });

  // The one native group is top level, so its client methods are not nested. Named after
  // the mount path, two bindings on different prefixes combine side by side, when no action
  // name, and so no operation ID, repeats across them.
  const api = apiOf(groupName(mount), endpoints);

  return { actions, errors, prefix: route(mount), api };
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
 * Route middleware of one `layer` call, run after the middleware around it. A request
 * without a content type is a 415, as on an MCP endpoint, where `HttpApi` would read it as
 * JSON: a page on any origin sends one, credentials included, without a CORS preflight.
 * Any other request runs over what its routes were built with, which fills in only what
 * the request lacks: what middleware provides per request, authentication included, wins,
 * as on a native route and in a `Toolkit` call.
 */
const entry = () =>
  HttpRouter.middleware(
    Effect.map(Effect.context<unknown>(), (built) => {
      // Never the layer's scope: a route runs in its request's, and each call in its own.
      const startup = Context.omit(Scope.Scope)(built);

      return (route) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
          request.headers["content-type"] === undefined
            ? Effect.succeed(
                HttpServerResponse.text("Unsupported content-type: none", { status: 415 }),
              )
            : Effect.updateContext(route, (current: Context.Context<never>) =>
                Context.merge(startup, current),
              ),
        );
    }),
  ).layer;

/**
 * Serve the binding's actions among `implementations` in one layer, each implementation's
 * `before` hook running after decoding, before each handler. The binding decides what is
 * served: an implementation's actions the binding leaves out have no route here, and one
 * holding none of the binding's is refused when `layer` is called. It mounts only the routes
 * of the actions it serves, so one binding may be served by several layers, such as public
 * routes beside authenticated ones: middleware provided to a layer covers its routes only.
 * Each implementation's builder runs once per layer graph however many layers serve it.
 *
 * The layer fails as the builders do, needs at startup what they need, and per request what
 * each implementation's hook needs and the handlers of the actions it serves, until
 * middleware provided around it, such as authentication, provides them; the router provides
 * its own, such as the request, to every route. Its routes take only requests typed as JSON,
 * and what middleware provides per request wins over what the layer was built with.
 */
export function layer<const H extends AnyHttp, const Apps extends Served>(
  http: H,
  implementations: Apps,
): Layer.Layer<
  never,
  BuildError<Member<Apps>>,
  | BuildContext<Member<Apps>>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      Exclude<ServedRequest<Member<Apps>, H["actions"][number]>, HttpRouter.Provided>
    >
  | Etag.Generator
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path
>;
export function layer(http: AnyHttp, served: Served): Layer.Layer<never, unknown, unknown> {
  const apps = toList(served);
  const actions = servedBy(http, apps);

  const mount = mountSegments(http.prefix);
  const name = groupName(mount);

  // Each endpoint anew, at the binding's paths: the binding's own carry what documents its
  // security, which enforces nothing. The server refuses undeclared payload fields; a client,
  // on the binding's own API, drops them when it encodes, as TypeScript lets a wider value
  // through.
  const api = apiOf(
    name,
    actions.map((action) =>
      endpointOf(action, route([...mount, action.name]), http.errors).middleware(SchemaErrors),
    ),
  ).annotate(HttpApi.PayloadParseOptions, { errors: "all", onExcessProperty: "error" });

  const handlers = Layer.unwrap(
    Effect.map(acquire(apps), (bound) => {
      // Own properties, so an action named `__proto__` is a route, not a prototype. Only the
      // served actions: a native group refuses a handler of an endpoint it lacks.
      const byName = Object.fromEntries(
        bound.flatMap(([action, run]) =>
          actions.includes(action)
            ? [[action.name, (request: Request) => recordStepUp(run(request.payload))] as const]
            : [],
        ),
      );

      return HttpApiBuilder.group(api, name, (builder) =>
        builder.handleAll(
          // SAFETY: the native router selects the endpoint, and so the action, before
          // its handler runs; `layer`'s signature restores every channel.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint registration boundary.
          byName as never,
        ),
      ).pipe(Layer.provide(schemaErrors), buildAlone);
    }),
  ).pipe(provideHandlers(apps));

  return HttpApiBuilder.layer(api).pipe(Layer.provide(handlers), Layer.provide(entry()));
}

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
  return Effect.map(methods(http, options), (methodOf) =>
    Object.fromEntries(http.actions.map((action) => [action.name, methodOf(action)])),
  );
}
