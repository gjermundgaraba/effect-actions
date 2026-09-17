import { Context, Effect, Layer, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { Etag, HttpClient, HttpPlatform, HttpRouter } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiClient,
  HttpApiMiddleware,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import type * as Action from "./Action.js";
import {
  type Actions,
  assertDistinct,
  type Each,
  type OneOrMore,
  type Served,
  served,
} from "./internal/actions.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type ErasedValue,
  Implementation,
  type RequestContext,
} from "./internal/implementation.js";

/** Contract-level configuration: servers and clients must agree on it. */
export interface Options<Errors extends ReadonlyArray<Action.Codec> = []> {
  readonly apiPath: `/${string}`;
  readonly schemaError?: Action.SchemaErrorPolicy<Errors>;
}

export interface LayerOptions {
  /** Set false when the host serves a combined document. */
  readonly openapiPath: `/${string}` | false;
}

/** Distribute over the tuple so each name retains its own codecs. */
type Endpoint<A extends Action.Any, E extends Action.Codec> = A extends { readonly http: false }
  ? never
  : A extends Action.Any
    ? HttpApiEndpoint.HttpApiEndpoint<
        A["name"],
        "POST",
        `/${string}`,
        never,
        never,
        Schema.toCodecJson<A["input"]>,
        never,
        Schema.toCodecJson<A["success"]>,
        Schema.toCodecJson<A["errors"][number] | E>
      >
    : never;

/** One native group per action group; groups without HTTP actions are omitted. */
type ApiGroup<G extends Actions, E extends Action.Codec> = G extends Actions
  ? [Endpoint<G["actions"][number], E>] extends [never]
    ? never
    : HttpApiGroup.HttpApiGroup<G["name"], Endpoint<G["actions"][number], E>>
  : never;

export type Api<G extends Actions, E extends Action.Codec = never> = HttpApi.HttpApi<
  "actions",
  ApiGroup<G, E>
>;

/** Direct decoded-input methods, excluding MCP-only actions. */
export type Client<G extends Actions, E extends Action.Codec = never> = {
  readonly [Item in G["actions"][number] as Item["http"] extends false ? never : Item["name"]]: (
    ...args: {} extends Item["input"]["Type"]
      ? [input?: Item["input"]["Type"]]
      : [input: Item["input"]["Type"]]
  ) => HttpApiClient.Client.MethodReturn<Endpoint<Item, E>, never, never, "decoded-only">;
};

/** Native connection options: `baseUrl`, `transformClient`, `transformResponse`. */
export type ClientOptions = NonNullable<Parameters<typeof HttpApiClient.make>[1]>;

export interface Http<G extends Actions, Errors extends ReadonlyArray<Action.Codec> = []> {
  /** The native `HttpApi` for every HTTP-enabled action: `POST <apiPath>/<name>`. */
  readonly api: Api<G, Errors[number]>;
  /** The OpenAPI 3.1 document Effect derives from `api`. */
  readonly openapi: () => OpenApi.OpenAPISpec;
  /**
   * Register the endpoints and optional OpenAPI document route on the router.
   * Handler requirements are request-level requirements, exactly as native
   * `HttpApiBuilder` handlers' are. Pass one implementation per group with an
   * HTTP action, in any order; others of these groups are accepted but not acquired.
   */
  readonly layer: <const A extends OneOrMore<AnyImplementation<G["actions"]>>>(
    apps: A,
    options: LayerOptions,
  ) => Layer.Layer<
    never,
    BuildError<Each<A>>,
    | BuildContext<Each<A>>
    | HttpRouter.HttpRouter
    | HttpRouter.Request.From<"Requires", RequestContext<Each<A>>>
    | Etag.Generator
    | FileSystem
    | HttpPlatform.HttpPlatform
    | Path
  >;
  /** Direct action methods backed by the native HTTP client and its codecs. */
  readonly client: (
    options?: ClientOptions,
  ) => Effect.Effect<Client<G, Errors[number]>, never, HttpClient.HttpClient>;
}

const endpoint = (apiPath: `/${string}`, action: Action.Any, errors: ReadonlyArray<Action.Codec>) =>
  HttpApiEndpoint.post(action.name, `${apiPath}/${action.name}`, {
    payload: action.input,
    success: action.success,
    error: [...action.errors, ...errors],
  }).annotate(OpenApi.Description, action.description);

type ErasedPolicy = Action.SchemaErrorPolicy<ReadonlyArray<Action.Codec>>;

type ErasedOptions = Options<ReadonlyArray<Action.Codec>>;

function erasedApi(
  views: ReadonlyArray<Served>,
  options: ErasedOptions,
): Api<Actions, Action.Codec>;
function erasedApi(views: ReadonlyArray<Served>, options: ErasedOptions): HttpApi.Constraint {
  const [first, ...rest] = views.flatMap(({ group, actions }) => {
    const [head, ...tail] = actions.map((action) =>
      endpoint(options.apiPath, action, options.schemaError?.errors ?? []),
    );

    return head === undefined ? [] : [HttpApiGroup.make(group.name).add(head, ...tail)];
  });

  const empty = HttpApi.make("actions");

  return first === undefined ? empty : empty.add(first, ...rest);
}

type ErasedImplementation<R, EX, RX> = Implementation<ReadonlyArray<Action.Any>, R, EX, RX>;

/**
 * Pairing is by group identity, so order is free and a look-alike group is
 * rejected. Only served groups need an implementation; one given for a bound
 * group without HTTP actions is neither required nor acquired.
 */
const paired = <R, EX, RX>(
  groups: ReadonlyArray<Actions>,
  views: ReadonlyArray<Served>,
  apps: ReadonlyArray<ErasedImplementation<R, EX, RX>>,
) => {
  for (const app of apps) {
    if (!groups.includes(app.group)) {
      throw new Error(`Implementation of group "${app.group.name}" is not served by this adapter`);
    }
  }

  return views.map(({ group, actions }) => {
    const [app, ...duplicates] = apps.filter((candidate) => candidate.group === group);

    if (app === undefined) throw new Error(`Missing implementation for group "${group.name}"`);

    if (duplicates.length > 0) {
      throw new Error(`Duplicate implementation for group "${group.name}"`);
    }

    return { app, actions };
  });
};

const erasedLayer = <R, EX, RX>(
  api: Api<Actions, Action.Codec>,
  serving: ReturnType<typeof paired<R, EX, RX>>,
  policy: ErasedPolicy | undefined,
  openapiPath: LayerOptions["openapiPath"],
) => {
  if (serving.length === 0) return Layer.empty;

  class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
    "effect-actions/http/SchemaErrors",
    { error: policy?.errors ?? [] },
  ) {}

  const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
    Effect.fail(
      policy === undefined
        ? failure
        : policy.map({
            phase:
              failure.kind === "Body" || failure.kind === "ResponseHeaders" ? "output" : "input",
            cause: failure.cause,
          }),
    ),
  );

  const httpApi = api.middleware(SchemaErrors);

  return Implementation.register(serving, (bound) => {
    const [first, ...rest] = bound.map((app) =>
      HttpApiBuilder.group(httpApi, app.group.name, (handlers) =>
        handlers.handleAll(
          Object.fromEntries(
            app.actions.map((action) => {
              const handle = app.handle(action);

              return [
                action.name,
                (request: { readonly payload: ErasedValue }) => handle(request.payload),
              ];
            }),
          ),
        ),
      ),
    );

    if (first === undefined) return Layer.empty;

    // Build the native groups with an empty context so build-time application
    // services cannot become request fallbacks.
    const isolated = Layer.fromBuildMemo((memoMap, scope) =>
      Layer.buildWithMemoMap(
        Layer.mergeAll(first, ...rest).pipe(Layer.provide(schemaErrors)),
        memoMap,
        scope,
      ).pipe(Effect.setContext(Context.empty())),
    );

    return HttpApiBuilder.layer(httpApi, {
      openapiPath: openapiPath === false ? undefined : openapiPath,
    }).pipe(Layer.provide(isolated));
  });
};

const erasedClient = (
  api: Api<Actions, Action.Codec>,
  views: ReadonlyArray<Served>,
  connection: ClientOptions | undefined,
) =>
  Effect.map(HttpApiClient.make(api, connection), (native) => {
    // Decide once from decoded input schemas: undefined is omitted input for
    // structs, but remains a value for codecs that explicitly accept it.
    const acceptsUndefined = new Set(
      views.flatMap(({ actions }) =>
        actions.flatMap((action) => (Schema.is(action.input)(undefined) ? [action.name] : [])),
      ),
    );

    return Object.fromEntries(
      Object.values(native).flatMap((methods) =>
        Object.entries(methods).map(([name, method]) => {
          // Callable "then" would make Promise resolution assimilate this client.
          if (name === "then")
            throw new Error('Action "then" requires the native grouped HttpApiClient');

          return [
            name,
            (input?: ErasedValue) =>
              method({
                payload: input === undefined && !acceptsUndefined.has(name) ? {} : input,
                responseMode: "decoded-only",
              }),
          ];
        }),
      ),
    );
  });

/**
 * Bind the contract-level configuration once. The native API is built here and
 * shared by the OpenAPI document, routes and clients, so they cannot disagree.
 */
export function make<
  const G extends OneOrMore<Actions>,
  const Errors extends ReadonlyArray<Action.Codec> = [],
>(groups: G, options: Options<Errors>): Http<Each<G>, Errors>;
export function make(
  groups: OneOrMore<Actions>,
  options: ErasedOptions,
): Http<Actions, ReadonlyArray<Action.Codec>> {
  const all = "actions" in groups ? [groups] : groups;

  const views = served(all, (action) => action.http);

  // Served groups become native group identifiers; their actions, routes and client methods.
  assertDistinct(
    "action group",
    views.map(({ group }) => group.name),
  );
  assertDistinct(
    "action",
    views.flatMap(({ actions }) => actions.map((action) => action.name)),
  );

  const api = erasedApi(views, options);

  return {
    api,
    openapi: () => OpenApi.fromApi(api),
    layer: (apps: OneOrMore<AnyImplementation>, layerOptions: LayerOptions) =>
      erasedLayer(
        api,
        paired(all, views, apps instanceof Implementation ? [apps] : apps),
        options.schemaError,
        layerOptions.openapiPath,
      ),
    client: (connection) => erasedClient(api, views, connection),
  };
}
