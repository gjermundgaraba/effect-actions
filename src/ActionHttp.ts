import { Effect, Layer, type Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import {
  type Etag,
  HttpEffect,
  type HttpPlatform,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  type HttpApiError,
  HttpApiMiddleware,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import type * as Action from "./Action.js";
import { assertDistinct, projectedErrors } from "./internal/actions.js";
import type { AnyHttp } from "./internal/client.js";
import { httpErrors, type HttpErrors, InvalidInput } from "./internal/errors.js";
import { challenge } from "./internal/respond.js";
import {
  acquire,
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  dispatch,
  type ErasedValue,
  type Hook,
  type Member,
  provideHandlers,
  type RequestContext,
  type Served,
  servedActions,
  toList,
} from "./internal/implementation.js";

/** Contract-level configuration: servers and clients must agree on it. */
interface Options {
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
 * not nested, named after the binding's mount path so bindings composed into one host
 * API keep their own groups.
 */
type Api<Actions extends ReadonlyArray<Action.Any>> = HttpApi.HttpApi<
  "actions",
  HttpApiGroup.HttpApiGroup<string, Endpoint<Actions[number]>, true>
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
 * An HTTP binding: actions and where they are mounted. Plain data, so a client importing
 * it bundles no server code, and a copy of it, or one made by another installed copy of
 * this package, serves the same; `layer` serves it.
 */
export interface Http<Actions extends ReadonlyArray<Action.Any>> {
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** Mount path of every route: `/api` by default, empty at the root. */
  readonly prefix: Prefix;
  readonly api: Api<Actions>;
}

/** A mount path as routes are joined to it: empty at the root. */
type Prefix = "" | `/${string}`;

/** What `layer` and `openApi` read of a binding. */
interface AnyBinding extends AnyHttp {
  readonly prefix: Prefix;
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
 * `HttpApiBuilder` reports these kinds while encoding the handler's answer, after the
 * handler ran; every other kind (`Payload`, `Params`, `Headers`, `Query`) comes from
 * decoding the request before it.
 */
const responseKinds: ReadonlySet<HttpApiError.HttpApiSchemaError["kind"]> = new Set([
  "Body",
  "ResponseHeaders",
]);

/**
 * The native middleware answering schema failures: a request that does not decode with
 * `InvalidInput` and the schema's own message, a result that does not encode as a defect,
 * the empty 500 of any other server bug.
 */
class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
  "effect-actions/http/SchemaErrors",
  { error: [InvalidInput] },
) {}

const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
  responseKinds.has(failure.kind)
    ? // Its cause, not the native failure: the failure itself renders as a 400.
      Effect.die(failure.cause)
    : Effect.fail(new InvalidInput({ message: failure.cause.message })),
);

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
  assertDistinct(
    "action",
    actions.map((action) => action.name),
  );

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
  // path: two bindings on different prefixes compose side by side.
  const api = apiOf(mount.join("/") || "actions", endpoints);

  return { actions, prefix, api };
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
>(http: H, apps: Apps, options?: Hook<RB>): HttpLayer<Member<Apps>, RB>;
export function layer(
  http: AnyBinding,
  served: Served,
  options: Hook<unknown> = {},
): Layer.Layer<never, unknown, unknown> {
  const apps = toList(served);
  const actions = servedActions("served action", apps);
  const name = groupOf(http.api).identifier;

  const api = apiOf(
    name,
    endpointsOf(http, actions).map((endpoint) => endpoint.middleware(SchemaErrors)),
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
                options.before,
              );

              // Whoever answers a 401, a hook or the handler itself, it carries a challenge.
              return [
                action.name,
                (request: Request) =>
                  HttpEffect.withPreResponseHandler(run(request.payload), challenge),
              ];
            }),
          ) as never,
        ),
      ),
    ),
  ).pipe(provideHandlers(apps));

  return HttpApiBuilder.layer(api).pipe(Layer.provide(handlers), Layer.provide(schemaErrors));
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
