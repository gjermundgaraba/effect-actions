import { Effect, Layer, type Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import { type Etag, type HttpPlatform, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiMiddleware,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import type * as Action from "./Action.js";
import {
  answerSchemaError,
  assertDistinct,
  projectedErrors,
  type SchemaErrorPolicy,
} from "./internal/actions.js";
import type { AnyHttp } from "./internal/client.js";
import {
  acquire,
  type AnyImplementation,
  type Before,
  type BuildContext,
  type BuildError,
  dispatch,
  type ErasedValue,
  type Member,
  provideHandlers,
  type RequestContext,
  type Served,
  servedActions,
  toList,
} from "./internal/implementation.js";

/** Contract-level configuration: servers and clients must agree on it. */
export interface Options<Errors extends ReadonlyArray<Action.Codec> = []> {
  /** Mount path of every route; defaults to `/api`. `/` mounts at the root. */
  readonly prefix?: `/${string}`;
  /**
   * The native group's name, which is its OpenAPI tag; defaults to the mount path.
   * Bindings composed into one host API need distinct names.
   */
  readonly name?: string;
  /**
   * Failures the surface around these endpoints answers with instead of a handler:
   * authentication, authorization, rate limits, invalid input. Declared on every
   * endpoint, so clients decode them as typed failures rather than reporting a decode
   * error. Each schema keeps its own `httpApiStatus`, and their `_tag`s must be distinct.
   */
  readonly errors?: Errors;
  /**
   * How HTTP answers a request that fails decoding (`invalid`) and a result that fails
   * encoding (`internal`), each with one of `errors`; an omitted side is Effect's empty
   * 400. MCP keeps its native answers.
   */
  readonly schemaError?: SchemaErrorPolicy<NoInfer<Errors[number]["Type"]>>;
}

/** What `layer` binds around the implementations it serves. */
export interface LayerOptions<E, R> {
  /**
   * Runs once after successful payload decoding, before the selected handler, with its
   * action contract. It fails with one of the binding's `errors`, encoded exactly like a
   * declared error. Its services are request-time requirements, like a handler's.
   */
  readonly before?: (action: Action.Any) => Effect.Effect<void, E, R>;
}

type Endpoint<A extends Action.Any, E extends Action.Codec> = A extends Action.Any
  ? HttpApiEndpoint.HttpApiEndpoint<
      A["name"],
      "POST",
      `/${string}`,
      never,
      never,
      Schema.toCodecJson<A["input"]>,
      never,
      Schema.toCodecJson<A["success"]>,
      Schema.toCodecJson<A["errors"][number] | E>,
      never
    >
  : never;

/**
 * The native `HttpApi` of `Actions`, declaring the extra errors `E` on each: one
 * top-level group, so native client methods are not nested, named after the binding's
 * mount path so bindings composed into one host API keep their own groups.
 */
type Api<
  Actions extends ReadonlyArray<Action.Any>,
  E extends Action.Codec = never,
> = HttpApi.HttpApi<
  "actions",
  HttpApiGroup.HttpApiGroup<string, Endpoint<Actions[number], E>, true>
>;

/**
 * What `layer` builds: failures, build services and request services are unions over
 * precisely the implementations `App` and the hook's services `RB`, joined by the router
 * and platform services `HttpApiBuilder.layer` needs.
 */
type HttpLayer<App, RB> = Layer.Layer<
  never,
  BuildError<App>,
  | BuildContext<App>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", RequestContext<App> | RB>
  | Etag.Generator
  | FileSystem
  | HttpPlatform.HttpPlatform
  | Path
>;

/**
 * An HTTP binding: actions, where they are mounted, and the errors around them. Plain
 * data, so a client importing it bundles no server code, and a copy of it, or one made by
 * another installed copy of this package, serves the same; `layer` serves it.
 */
export interface Http<
  Actions extends ReadonlyArray<Action.Any>,
  Errors extends ReadonlyArray<Action.Codec> = [],
> {
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** Every error declared on every endpoint beyond the action's own. */
  readonly errors: Errors;
  /** Mount path of every route: `/api` by default, empty at the root. */
  readonly prefix: Prefix;
  /** How `layer` answers schema failures, as `make` was given it. */
  readonly schemaError?: SchemaErrorPolicy<Errors[number]["Type"]>;
  readonly api: Api<Actions, Errors[number]>;
}

/** A mount path as routes are joined to it: empty at the root. */
type Prefix = "" | `/${string}`;

/** What `layer` and `openApi` read of a binding. */
interface AnyBinding extends AnyHttp {
  readonly prefix: Prefix;
  readonly schemaError?: SchemaErrorPolicy;
}

type ErasedOptions = Options<ReadonlyArray<Action.Codec>>;

/** A native request, as `HttpApiBuilder.handleAll` passes it to a handler. */
interface Request {
  readonly payload: ErasedValue;
}

/** The mount path's segments: `api` by default; none for `/`. */
const mountSegments = (prefix: `/${string}` | undefined): ReadonlyArray<string> =>
  (prefix ?? "/api").split("/").filter((segment) => segment !== "");

/** An absolute route from path segments. */
const route = (segments: ReadonlyArray<string>): `/${string}` => `/${segments.join("/")}`;

let middlewares = 0;

/**
 * The native middleware answering schema failures with `policy`, and its layer. It
 * declares the binding's `errors` it answers with; every endpoint declares them too, and
 * Effect keeps each schema once.
 */
const schemaErrors = (errors: ReadonlyArray<Action.Codec>, policy: SchemaErrorPolicy) => {
  class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
    `effect-actions/http/SchemaErrors/${(middlewares += 1)}`,
    { error: errors },
  ) {}

  return {
    middleware: SchemaErrors,
    layer: HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
      Effect.fail(answerSchemaError(policy, failure)),
    ),
  };
};

/** A native API of one top-level group of `endpoints`. */
function apiOf(
  group: string,
  endpoints: ReadonlyArray<HttpApiEndpoint.Constraint>,
): Api<ReadonlyArray<Action.Any>, Action.Codec>;
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

/** Bind actions once, for servers and clients alike, each at `POST <prefix>/<action>`. */
export function make<
  const Actions extends ReadonlyArray<Action.Any>,
  const E extends ReadonlyArray<Action.Codec> = [],
>(actions: Actions, options?: Options<E>): Http<Actions, E>;
export function make(
  actions: ReadonlyArray<Action.Any>,
  options: ErasedOptions = {},
): Http<ReadonlyArray<Action.Any>, ReadonlyArray<Action.Codec>> {
  assertDistinct(
    "action",
    actions.map((action) => action.name),
  );

  const mount = mountSegments(options.prefix);
  const prefix = mount.length === 0 ? "" : route(mount);
  const errors = options.errors ?? [];

  const endpoints = actions.map((action) =>
    HttpApiEndpoint.post(action.name, route([...mount, action.name]), {
      payload: action.input,
      success: action.success,
      error: projectedErrors(action, errors),
    }).annotate(OpenApi.Description, action.description),
  );

  // The one native group is top level, so its client methods are not nested. Its name
  // is its OpenAPI tag, and `HttpApi.addHttpApi` keys groups by it, so it defaults to
  // the mount path: two bindings on different prefixes compose side by side.
  const api = apiOf(options.name ?? (mount.join("/") || "actions"), endpoints);

  return {
    actions,
    errors,
    prefix,
    ...(options.schemaError === undefined ? {} : { schemaError: options.schemaError }),
    api,
  };
}

/**
 * Serve implementations of a binding's actions in one layer, with one pre-handler hook
 * around every request they answer. Each call mounts only the routes of the actions it
 * serves, so actions with different middleware are served by separate calls. Each
 * implementation's builder runs once however many layers serve it.
 */
export function layer<
  const H extends AnyBinding,
  const Apps extends Served &
    (
      | AnyImplementation<H["actions"][number]>
      | ReadonlyArray<AnyImplementation<H["actions"][number]>>
    ),
  RB = never,
>(
  http: H,
  apps: Apps,
  options?: LayerOptions<H["errors"][number]["Type"], RB>,
): HttpLayer<Member<Apps>, RB>;
export function layer(
  http: AnyBinding,
  served: Served,
  options: LayerOptions<unknown, unknown> = {},
): Layer.Layer<never, unknown, unknown> {
  const apps = toList(served);
  const actions = servedActions("served action", apps);
  const name = groupOf(http.api).identifier;
  const before: Before<unknown> | undefined = options.before;

  const answer =
    http.schemaError === undefined ? undefined : schemaErrors(http.errors, http.schemaError);

  const api = apiOf(
    name,
    endpointsOf(http, actions).map((endpoint) =>
      answer === undefined ? endpoint : endpoint.middleware(answer.middleware),
    ),
  );

  const handlers = Layer.unwrap(
    Effect.map(acquire(apps), (handlerOf) =>
      HttpApiBuilder.group(api, name, (builder) =>
        builder.handleAll(
          // SAFETY: the native router selects the endpoint, and so the action, before
          // `dispatch` calls its handler; `layer`'s signature restores every channel.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint registration boundary.
          Object.fromEntries(
            // Own properties, so an action named `__proto__` is a route, not a prototype.
            actions.map((action) => {
              const run = dispatch<Action.Any, ErasedValue, unknown>(
                action,
                handlerOf(action),
                before,
              );

              return [action.name, (request: Request) => run(request.payload)];
            }),
          ) as never,
        ),
      ),
    ),
  ).pipe(provideHandlers(apps));

  return HttpApiBuilder.layer(api).pipe(
    Layer.provide(handlers),
    Layer.provide(answer?.layer ?? Layer.empty),
  );
}

/**
 * Serve the OpenAPI document of a binding with `GET path`, by default
 * `<prefix>/openapi.json`. It is a plain route: middleware provided to this layer
 * covers it, and none is applied otherwise.
 */
export const openApi = (
  http: AnyBinding,
  path: HttpRouter.PathInput = `${http.prefix}/openapi.json`,
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.add("GET", path, HttpServerResponse.jsonUnsafe(OpenApi.fromApi(native(http.api))));
