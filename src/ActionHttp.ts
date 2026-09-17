import { Context, Effect, Layer, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import {
  type Etag,
  type HttpClient,
  type HttpPlatform,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";
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
import { type Actions, assertDistinct, type Served, served } from "./internal/actions.js";
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
   * The routes of one group. Merge one per group; router middleware provided
   * to a layer applies to that group only. Handler requirements are
   * request-level requirements, exactly as native `HttpApiBuilder` handlers'
   * are. A group without HTTP actions registers nothing and is not acquired.
   */
  readonly layer: <App extends AnyImplementation<G>>(
    app: App,
  ) => Layer.Layer<
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
  /** A route serving the OpenAPI document of every group, under its own middleware. */
  readonly layerOpenapi: (path: `/${string}`) => Layer.Layer<never, never, HttpRouter.HttpRouter>;
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

type ErasedImplementation<R, EX, RX> = Implementation<Actions, R, EX, RX>;

/** Everything `make` fixes once and every route layer shares. */
interface Binding {
  readonly groups: ReadonlyArray<Actions>;
  readonly views: ReadonlyArray<Served>;
  readonly options: ErasedOptions;
  readonly schemaErrors: ReturnType<typeof schemaErrorMiddleware>;
}

const schemaErrorMiddleware = (policy: ErasedPolicy | undefined) => {
  class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
    "effect-actions/http/SchemaErrors",
    { error: policy?.errors ?? [] },
  ) {}

  const layer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
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

  return { SchemaErrors, layer };
};

/** One group registers its own routes, so middleware provided to this layer is its alone. */
const erasedLayer = <R, EX, RX>(binding: Binding, app: ErasedImplementation<R, EX, RX>) => {
  // Pairing is by group identity, so a look-alike group is rejected.
  if (!binding.groups.includes(app.group)) {
    throw new Error(`Implementation of group "${app.group.name}" is not served by this adapter`);
  }

  const view = binding.views.find(({ group }) => group === app.group);

  // A group without HTTP actions has no routes and is not acquired.
  if (view === undefined) return Layer.empty;

  const httpApi = erasedApi([view], binding.options).middleware(binding.schemaErrors.SchemaErrors);

  return Implementation.register([{ app, actions: view.actions }], (bound) => {
    const handlers = bound.map((implementation) =>
      HttpApiBuilder.group(httpApi, implementation.group.name, (builder) =>
        builder.handleAll(
          Object.fromEntries(
            implementation.actions.map((action) => {
              const handle = implementation.handle(action);

              return [
                action.name,
                (request: { readonly payload: ErasedValue }) => handle(request.payload),
              ];
            }),
          ),
        ),
      ),
    );

    // Build the native group with an empty context so build-time application
    // services cannot become request fallbacks.
    const isolated = Layer.fromBuildMemo((memoMap, scope) =>
      Layer.buildWithMemoMap(
        Layer.mergeAll(Layer.empty, ...handlers).pipe(Layer.provide(binding.schemaErrors.layer)),
        memoMap,
        scope,
      ).pipe(Effect.setContext(Context.empty())),
    );

    return HttpApiBuilder.layer(httpApi).pipe(Layer.provide(isolated));
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
  const G extends ReadonlyArray<Actions>,
  const Errors extends ReadonlyArray<Action.Codec> = [],
>(options: Options<Errors>, ...groups: G): Http<G[number], Errors>;
export function make(
  options: ErasedOptions,
  ...groups: ReadonlyArray<Actions>
): Http<Actions, ReadonlyArray<Action.Codec>> {
  const views = served(groups, (action) => action.http);

  // A group's name is its identity here: native group identifier and OpenAPI
  // tag. Served actions become routes and client methods.
  assertDistinct(
    "action group",
    groups.map((group) => group.name),
  );
  assertDistinct(
    "action",
    views.flatMap(({ actions }) => actions.map((action) => action.name)),
  );

  const api = erasedApi(views, options);

  const binding: Binding = {
    groups,
    views,
    options,
    schemaErrors: schemaErrorMiddleware(options.schemaError),
  };

  // The contract is fixed here, so its document is serialized once.
  let document: HttpServerResponse.HttpServerResponse | undefined;

  return {
    api,
    openapi: () => OpenApi.fromApi(api),
    layer: (app: AnyImplementation) => erasedLayer(binding, app),
    layerOpenapi: (path) =>
      HttpRouter.add(
        "GET",
        path,
        Effect.sync(() => (document ??= HttpServerResponse.jsonUnsafe(OpenApi.fromApi(api)))),
      ),
    client: (connection) => erasedClient(api, views, connection),
  };
}
