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
  policyErrors,
  projectedErrors,
  type SchemaErrorPolicy,
} from "./internal/actions.js";
import {
  acquire,
  type AnyImplementation,
  type Before,
  type BuildContext,
  type BuildError,
  dispatch,
  type ErasedValue,
  type RequestContext,
} from "./internal/implementation.js";

/** An HTTP schema-error policy and each of its two answers. */
export type { SchemaErrorAnswer, SchemaErrorPolicy } from "./internal/actions.js";

/** Contract-level configuration: servers and clients must agree on it. */
export interface Options<
  Errors extends ReadonlyArray<Action.Codec> = [],
  Invalid extends Action.Codec = never,
  Internal extends Action.Codec = never,
> {
  /** Mount path of every route; defaults to `/api`. `/` mounts at the root. */
  readonly prefix?: `/${string}`;
  /**
   * Failures the surface around these endpoints answers with instead of a
   * handler: authentication, authorization, rate limits. Declared on every
   * endpoint, so clients decode them as typed failures rather than reporting a
   * decode error. Each schema keeps its own `httpApiStatus`, and their `_tag`s
   * must be distinct.
   */
  readonly errors?: Errors;
  /**
   * How HTTP answers a request that fails decoding (`invalid`) and a result that fails
   * encoding (`internal`); without one, both are Effect's empty 400. MCP keeps its
   * native answers.
   */
  readonly schemaError?: SchemaErrorPolicy<Invalid, Internal>;
}

/** What `Http.layer` binds around the implementations it serves. */
export interface LayerOptions<Errors extends ReadonlyArray<Action.Codec>, R> {
  /**
   * Runs once after successful payload decoding, before the selected handler,
   * with its action contract. It fails with the binding's own `errors`, encoded
   * exactly like a declared error. Its services are request-time
   * requirements, like a handler's.
   */
  readonly before?: (action: Action.Any) => Effect.Effect<void, Errors[number]["Type"], R>;
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
export type Api<
  Actions extends ReadonlyArray<Action.Any>,
  E extends Action.Codec = never,
> = HttpApi.HttpApi<
  "actions",
  [Actions[number]] extends [never]
    ? never
    : HttpApiGroup.HttpApiGroup<string, Endpoint<Actions[number], E>, true>
>;

/**
 * What `Http.layer` builds: failures, build services and request services are unions
 * over precisely the implementations `Apps` and the hook's services `RB`, joined by the
 * router and platform services `HttpApiBuilder.layer` needs.
 */
export type HttpLayer<Apps extends ReadonlyArray<AnyImplementation>, RB> = Layer.Layer<
  never,
  BuildError<Apps[number]>,
  | BuildContext<Apps[number]>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", RequestContext<Apps[number]> | RB>
  | Etag.Generator
  | FileSystem
  | HttpPlatform.HttpPlatform
  | Path
>;

/** An HTTP binding: actions, where they are mounted, and the errors around them. */
export interface Http<
  Actions extends ReadonlyArray<Action.Any>,
  Errors extends ReadonlyArray<Action.Codec> = [],
  Policy extends Action.Codec = never,
> {
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** Every error declared on every endpoint beyond the action's own: surface and policy. */
  readonly errors: ReadonlyArray<Errors[number] | Policy>;
  readonly api: Api<Actions, Errors[number] | Policy>;
  /**
   * Serve any number of implementations of this binding's actions in one layer, with
   * one pre-handler hook around every request they answer. Each call mounts only the
   * routes of the implementations it receives, so actions with different middleware
   * are served by separate calls.
   */
  readonly layer: <
    const Apps extends ReadonlyArray<AnyImplementation<Actions[number]>>,
    RB = never,
  >(
    apps: readonly [...Apps],
    options?: LayerOptions<Errors, RB>,
  ) => HttpLayer<Apps, RB>;
  /**
   * Serve the OpenAPI document of `api` with `GET path`, by default
   * `<prefix>/openapi.json`. It is a plain route: middleware provided to this layer
   * covers it, and none is applied otherwise.
   */
  readonly openApi: (
    path?: HttpRouter.PathInput,
  ) => Layer.Layer<never, never, HttpRouter.HttpRouter>;
}

type ErasedOptions = Options<ReadonlyArray<Action.Codec>, Action.Codec, Action.Codec>;

/** A native request, as `HttpApiBuilder.handleAll` passes it to a handler. */
interface Request {
  readonly payload: ErasedValue;
}

/** The mount path's segments: `api` by default; none for `/`. */
const mountSegments = (prefix: `/${string}` | undefined): ReadonlyArray<string> =>
  (prefix ?? "/api").split("/").filter((segment) => segment !== "");

/** An absolute route from path segments. */
const route = (segments: ReadonlyArray<string>): `/${string}` => `/${segments.join("/")}`;

/** The native middleware declares the policy's errors on every endpoint it wraps. */
const schemaErrorMiddleware = (prefix: string, policy: SchemaErrorPolicy) => {
  class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
    `effect-actions/http/SchemaErrors${prefix}`,
    { error: policyErrors(policy) },
  ) {}

  return {
    SchemaErrors,
    layer: HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
      Effect.fail(answerSchemaError(policy, failure)),
    ),
  };
};

/** Bind actions once, for servers and clients alike, each at `POST <prefix>/<action>`. */
export function make<
  const Actions extends ReadonlyArray<Action.Any>,
  const E extends ReadonlyArray<Action.Codec> = [],
  Invalid extends Action.Codec = never,
  Internal extends Action.Codec = never,
>(actions: Actions, options?: Options<E, Invalid, Internal>): Http<Actions, E, Invalid | Internal>;
export function make(
  actions: ReadonlyArray<Action.Any>,
  options: ErasedOptions = {},
): Http<ReadonlyArray<Action.Any>, ReadonlyArray<Action.Codec>, Action.Codec> {
  assertDistinct(
    "action",
    actions.map((action) => action.name),
  );

  const mount = mountSegments(options.prefix);
  const prefix = mount.length === 0 ? "" : route(mount);

  // The one native group is top level, so its client methods are not nested. Its name
  // is the mount path, `/api` or `/`, which is also its OpenAPI tag: `HttpApi.addHttpApi`
  // keys groups by name, so two bindings on different prefixes compose side by side.
  const group = route(mount);

  const policy =
    options.schemaError === undefined
      ? undefined
      : schemaErrorMiddleware(prefix, options.schemaError);

  const endpoints = new Map(
    actions.map((action) => [
      action,
      HttpApiEndpoint.post(action.name, route([...mount, action.name]), {
        payload: action.input,
        success: action.success,
        error: projectedErrors(action, options.errors),
      }).annotate(OpenApi.Description, action.description),
    ]),
  );

  const endpointOf = (action: Action.Any): HttpApiEndpoint.Constraint => {
    const endpoint = endpoints.get(action);

    if (endpoint === undefined) {
      throw new Error(`Action "${action.name}" is not in this HTTP binding`);
    }

    return endpoint;
  };

  /** A native API of exactly `served`, with the binding's policy on its group. */
  function apiOf(served: ReadonlyArray<Action.Any>): Api<ReadonlyArray<Action.Any>, Action.Codec>;
  function apiOf(served: ReadonlyArray<Action.Any>): HttpApi.Constraint {
    const empty = HttpApi.make("actions").annotate(HttpApi.ParseOptions, { errors: "all" });
    const [first, ...rest] = served.map(endpointOf);

    if (first === undefined) return empty;

    const native = HttpApiGroup.make(group, { topLevel: true }).add(first, ...rest);

    return empty.add(policy === undefined ? native : native.middleware(policy.SchemaErrors));
  }

  const api = apiOf(actions);

  const layer = <const Apps extends ReadonlyArray<AnyImplementation>, RB = never>(
    apps: readonly [...Apps],
    layerOptions: LayerOptions<ReadonlyArray<Action.Codec>, RB> = {},
  ): HttpLayer<Apps, RB> => {
    const served = apiOf(apps.map((app) => app.action));

    // Every action is in the binding, whose names are distinct, so a repeated name is a
    // repeated action.
    assertDistinct(
      "served action",
      apps.map((app) => app.action.name),
    );

    const before: Before<unknown> | undefined = layerOptions.before;

    const handlers =
      apps.length === 0
        ? Layer.empty
        : Layer.unwrap(
            Effect.map(acquire(apps), (handlerOf) =>
              HttpApiBuilder.group(served, group, (builder) =>
                builder.handleAll(
                  // SAFETY: the native router selects the endpoint, and so the action, before
                  // `dispatch` calls its handler; `Http.layer`'s signature restores every channel.
                  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint registration boundary.
                  Object.fromEntries(
                    // Own properties, so an action named `__proto__` is a route, not a prototype.
                    apps.map((app) => {
                      const run = dispatch<Action.Any, ErasedValue, unknown>(
                        app.action,
                        handlerOf(app),
                        before,
                      );

                      return [app.action.name, (request: Request) => run(request.payload)];
                    }),
                  ) as never,
                ),
              ),
            ),
          );

    // SAFETY: handlers are built from exactly these implementations, so the layer's
    // failures and services are the unions `HttpLayer` states.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic tuple reduction cannot express the public union.
    return HttpApiBuilder.layer(served).pipe(
      Layer.provide(handlers),
      Layer.provide(policy?.layer ?? Layer.empty),
    ) as HttpLayer<Apps, RB>;
  };

  const openApi = (path: HttpRouter.PathInput = route([...mount, "openapi.json"])) =>
    HttpRouter.add("GET", path, HttpServerResponse.jsonUnsafe(OpenApi.fromApi(api)));

  const errors = [
    ...(options.errors ?? []),
    ...(options.schemaError === undefined ? [] : policyErrors(options.schemaError)),
  ];

  return { actions, errors, api, layer, openApi };
}
