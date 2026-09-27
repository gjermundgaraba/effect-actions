import { Effect, Layer, type Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import { type Etag, type HttpPlatform, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
// Its own module rather than the barrel's namespace, which esbuild keeps whole in a client.
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import type * as Action from "./Action.js";
import { assertDistinct, projectedErrors } from "./internal/actions.js";
import {
  type AnyHttp,
  type Client,
  type ErasedMethod,
  methods,
  type Options as ClientOptions,
  type Prefix,
} from "./internal/client.js";
import { httpErrors, type HttpErrors } from "./internal/errors.js";
import { preflight } from "./internal/refusal.js";
import { SchemaErrors, schemaErrors } from "./internal/schema-errors.js";
import {
  acquire,
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type ErasedValue,
  type Member,
  provideHandlers,
  type RequestContext,
  type Served,
  servedActions,
  toList,
} from "./internal/implementation.js";

/** A client's methods, one per action of the binding. */
export type { Client } from "./internal/client.js";

/** Any HTTP binding, with its actions erased: what `layer`, `client` and `openApi` read. */
export type { AnyHttp as Any } from "./internal/client.js";

/**
 * The native `HttpApiClient.make` options `client` takes: `baseUrl` and `transformClient`.
 */
export type { Options as ClientOptions } from "./internal/client.js";

/** Contract-level configuration: servers and clients must agree on it. */
export interface Options {
  /** Mount path of every route; defaults to `/api`. `/` mounts at the root. */
  readonly prefix?: `/${string}`;
}

type Endpoint<A extends Action.Any> = A extends Action.Any
  ? HttpApiEndpoint.HttpApiEndpoint<
      A["name"],
      "POST",
      `/${string}`,
      never,
      never,
      Schema.toCodecJson<A["input"]>,
      never,
      Schema.toCodecJson<A["success"]>,
      Schema.toCodecJson<A["errors"][number] | HttpErrors>,
      never
    >
  : never;

/**
 * The native `HttpApi` of `Actions`: one top-level group, so native client methods are
 * not nested, named after the binding's mount path, `/` at the root, so bindings composed
 * into one host API keep their own groups.
 */
type Api<Actions extends ReadonlyArray<Action.Any>> = HttpApi.HttpApi<
  "actions",
  HttpApiGroup.HttpApiGroup<string, Endpoint<Actions[number]>, true>
>;

/**
 * What `layer` builds: failures, build services and request services are unions over
 * precisely the implementations `App`, joined by the router and platform services
 * `HttpApiBuilder.layer` needs. Middleware provided around it, such as authentication,
 * removes the request services it provides.
 */
type HttpLayer<App> = Layer.Layer<
  never,
  BuildError<App>,
  | BuildContext<App>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", RequestContext<App>>
  | Etag.Generator
  | FileSystem
  | HttpPlatform.HttpPlatform
  | Path
>;

/**
 * An HTTP binding: actions and where they are mounted. Plain data, so a copy of it, or
 * one made by another installed copy of this package, serves the same; `layer` serves it
 * and `client` calls it.
 */
export interface Http<Actions extends ReadonlyArray<Action.Any>> {
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** Mount path of every route: `/api` by default, empty at the root. */
  readonly prefix: Prefix;
  readonly api: Api<Actions>;
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

/** A native API of one top-level group of `endpoints`. */
function apiOf(
  group: string,
  endpoints: ReadonlyArray<HttpApiEndpoint.Constraint>,
): Api<ReadonlyArray<Action.Any>>;
function apiOf(
  group: string,
  endpoints: ReadonlyArray<HttpApiEndpoint.Constraint>,
): HttpApi.Constraint {
  const empty = HttpApiGroup.make(group, { topLevel: true });
  const [first, ...rest] = endpoints;

  return HttpApi.make("actions")
    .annotate(HttpApi.ParseOptions, { errors: "all" })
    .add(first === undefined ? empty : empty.add(first, ...rest));
}

/** A binding's API as the native helpers read it. */
const native = (api: HttpApi.Constraint): HttpApi.Top =>
  // SAFETY: every binding API is a native `HttpApi` of one group; only its invariant
  // group map is erased.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native API boundary.
  api as HttpApi.Top;

/** The binding's one native group, as `make` built it. */
const groupOf = (api: HttpApi.Constraint): HttpApiGroup.Top => {
  const [group] = Object.values(native(api).groups);

  if (group === undefined) throw new Error("Not an HTTP binding made by ActionHttp.make");

  return group;
};

/** The native endpoint of each of `served`, refusing an action outside the binding. */
const endpointsOf = (
  http: AnyHttp,
  served: ReadonlyArray<Action.Any>,
): ReadonlyArray<HttpApiEndpoint.Top> =>
  served.map((action) => {
    const endpoint = http.actions.includes(action)
      ? groupOf(http.api).endpoints[action.name]
      : undefined;

    if (endpoint === undefined) {
      throw new Error(`Action "${action.name}" is not in this HTTP binding`);
    }

    return endpoint;
  });

/**
 * Bind actions once, for servers and clients alike, each at `POST <prefix>/<action>`.
 * Every endpoint declares its action's errors and the built-in `InvalidInput`,
 * `Unauthenticated` and `Forbidden`, so clients decode each as a typed failure.
 */
export function make<const Actions extends ReadonlyArray<Action.Any>>(
  actions: Actions,
  options?: Options,
): Http<Actions>;
export function make(
  actions: ReadonlyArray<Action.Any>,
  options: Options = {},
): Http<ReadonlyArray<Action.Any>> {
  assertDistinct("action", actions, (action) => action.name);

  const mount = mountSegments(options.prefix);
  const prefix = mount.length === 0 ? "" : route(mount);

  const endpoints = actions.map((action) =>
    HttpApiEndpoint.post(action.name, route([...mount, action.name]), {
      payload: action.input,
      success: action.success,
      error: projectedErrors(action, httpErrors),
    }).annotate(OpenApi.Description, action.description),
  );

  // The one native group is top level, so its client methods are not nested. Its name
  // is its OpenAPI tag, and `HttpApi.addHttpApi` keys groups by it, so it is the mount
  // path, `/` at the root, which no segment contains: two bindings on different prefixes
  // combine side by side, when no action name, and so no operation ID, repeats across them.
  const api = apiOf(mount.join("/") || "/", endpoints);

  return { actions, prefix, api };
}

/**
 * Serve implementations of a binding's actions in one layer, each implementation's `before`
 * hook running before the request is decoded, so a refused caller learns nothing of the
 * input, and its refusal answered with its status. It mounts only the routes of the
 * actions it serves, so one binding may be served by several layers, such as public
 * routes beside authenticated ones: middleware provided to a layer covers its routes
 * only. Each implementation's builder runs once however many layers serve it.
 */
export function layer<
  const H extends AnyHttp,
  const Apps extends Served &
    (
      | AnyImplementation<H["actions"][number]>
      | ReadonlyArray<AnyImplementation<H["actions"][number]>>
    ),
>(http: H, apps: Apps): HttpLayer<Member<Apps>>;
export function layer(http: AnyHttp, served: Served): Layer.Layer<never, unknown, unknown> {
  const apps = toList(served);
  const actions = servedActions("served action", apps);
  const name = groupOf(http.api).identifier;

  const api = apiOf(
    name,
    endpointsOf(http, actions).map((endpoint) => endpoint.middleware(SchemaErrors)),
  );

  const handlers = Layer.unwrap(
    Effect.map(acquire(apps), (bound) =>
      HttpApiBuilder.group(api, name, (builder) =>
        builder.handleAll(
          // SAFETY: the native router selects the endpoint, and so the action, before
          // its handler runs; `layer`'s signature restores every channel.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint registration boundary.
          Object.fromEntries(
            // Own properties, so an action named `__proto__` is a route, not a prototype.
            bound.map(([action, run]) => [action.name, (request: Request) => run(request.payload)]),
          ) as never,
        ),
      ),
    ),
  );

  // Each served action's route, as the router matched it, selects its hook.
  const hooks = preflight(apps, (bound) => {
    const byRoute = new Map(bound.map((entry) => [`${http.prefix}/${entry[0].name}`, entry]));

    return (_request, route) => (route.method === "POST" ? byRoute.get(route.path) : undefined);
  });

  return HttpApiBuilder.layer(api).pipe(
    Layer.provide(handlers),
    Layer.provide(schemaErrors),
    Layer.provide(hooks),
    provideHandlers(apps),
  );
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

/**
 * Serve the OpenAPI document of a binding with `GET path`, by default
 * `<prefix>/openapi.json`. It is a plain route: middleware provided to this layer
 * covers it, and none is applied otherwise.
 */
export const openApi = (
  http: AnyHttp,
  path: HttpRouter.PathInput = `${http.prefix}/openapi.json`,
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.add("GET", path, HttpServerResponse.jsonUnsafe(OpenApi.fromApi(native(http.api))));
