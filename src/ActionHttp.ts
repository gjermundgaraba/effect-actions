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
export interface Options<
  Errors extends ReadonlyArray<Action.Codec> = [],
  Mount extends `/${string}` = `/${string}`,
> {
  readonly apiPath: Mount;
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

/**
 * Provided by the route layer of one group and required by `Http.groups`, so a
 * group that is bound but never mounted is an unsatisfied Layer requirement.
 * It names the routes themselves: where they are mounted, and the group. The
 * name is invariant, so a layer built from a union of implementations, which
 * cannot say which group it mounted, satisfies none of them.
 */
export interface Mounted<Mount extends string, Name extends string> {
  readonly _: "effect-actions/http/Mounted";
  readonly mount: Mount;
  readonly name: (name: Name) => Name;
}

// A mapped lookup distributes over the names without a conditional type.
type MountedEach<Mount extends string, Name extends string> = {
  readonly [N in Name]: Mounted<Mount, N>;
}[Name];

/** Groups without HTTP actions have no routes, so nothing needs to mount them. */
type ServedName<G extends Actions> = G extends Actions
  ? [Endpoint<G["actions"][number], never>] extends [never]
    ? never
    : G["name"]
  : never;

type Routes<App> =
  | BuildContext<App>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", RequestContext<App>>
  | Etag.Generator
  | FileSystem
  | HttpPlatform.HttpPlatform
  | Path;

export interface Http<
  G extends Actions,
  Errors extends ReadonlyArray<Action.Codec> = [],
  Mount extends `/${string}` = `/${string}`,
> {
  /** The native `HttpApi` for every HTTP-enabled action: `POST <apiPath>/<name>`. */
  readonly api: Api<G, Errors[number]>;
  /** The OpenAPI 3.1 document Effect derives from `api`. */
  readonly openapi: () => OpenApi.OpenAPISpec;
  /**
   * Every group under one middleware stack: the optional OpenAPI document
   * route plus `group` for each implementation. Needs one implementation per
   * group with an HTTP action, in any order. Handler requirements are
   * request-level requirements, exactly as native `HttpApiBuilder` handlers' are.
   */
  readonly layer: <const A extends OneOrMore<AnyImplementation<G>>>(
    apps: A,
    options: LayerOptions,
  ) => Layer.Layer<never, BuildError<Each<A>>, Routes<Each<A>>>;
  /**
   * The routes of one group, as their own layer: router middleware provided to
   * it applies to this group only.
   */
  readonly group: <App extends AnyImplementation<G>>(
    app: App,
  ) => Layer.Layer<Mounted<Mount, App["group"]["name"]>, BuildError<App>, Routes<App>>;
  /**
   * For groups under their own middleware: the optional OpenAPI document route,
   * requiring the `group` layer of every group with an HTTP action, so one left
   * unmounted does not compile.
   */
  readonly groups: (
    options: LayerOptions,
  ) => Layer.Layer<never, never, HttpRouter.HttpRouter | MountedEach<Mount, ServedName<G>>>;
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

type MountedTag = Context.Service<Mounted<`/${string}`, string>, true>;

let bindings = 0;

/** Everything `make` fixes once and every route layer shares. */
interface Binding {
  readonly views: ReadonlyArray<Served>;
  readonly options: ErasedOptions;
  readonly mounted: ReadonlyMap<Actions, MountedTag>;
  readonly schemaErrors: ReturnType<typeof schemaErrorMiddleware>;
  /** The contract is fixed at `make`, so its document is serialized once. */
  readonly document: () => HttpServerResponse.HttpServerResponse;
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

const mountedTag = (binding: Binding, group: Actions): MountedTag => {
  const tag = binding.mounted.get(group);

  // Pairing is by group identity, so a look-alike group is rejected.
  if (tag === undefined) {
    throw new Error(`Implementation of group "${group.name}" is not served by this adapter`);
  }

  return tag;
};

/** One group registers its own routes, so middleware provided to this layer is its alone. */
const erasedGroup = <R, EX, RX>(binding: Binding, app: ErasedImplementation<R, EX, RX>) => {
  const mounted = Layer.succeed(mountedTag(binding, app.group), true);
  const view = binding.views.find(({ group }) => group === app.group);

  // A group without HTTP actions has no routes and is not acquired.
  if (view === undefined) return mounted;

  const httpApi = erasedApi([view], binding.options).middleware(binding.schemaErrors.SchemaErrors);

  const routes = Implementation.register([{ app, actions: view.actions }], (bound) => {
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

  return Layer.merge(routes, mounted);
};

/** The document route, requiring every served group so an unmounted one cannot go unnoticed. */
const erasedGroups = (binding: Binding, openapiPath: LayerOptions["openapiPath"]) => {
  const complete = Layer.effectDiscard(
    Effect.forEach(binding.views, ({ group }) => mountedTag(binding, group), { discard: true }),
  );

  // An adapter without any HTTP action registers nothing, the document included.
  return openapiPath === false || binding.views.length === 0
    ? complete
    : Layer.merge(complete, HttpRouter.add("GET", openapiPath, Effect.sync(binding.document)));
};

const erasedLayer = <R, EX, RX>(
  binding: Binding,
  apps: ReadonlyArray<ErasedImplementation<R, EX, RX>>,
  openapiPath: LayerOptions["openapiPath"],
) => {
  const groups = apps.map((app) => erasedGroup(binding, app));

  // Only what this adapter serves is paired, by identity: exactly one implementation each.
  for (const { group } of binding.views) {
    const count = apps.filter((app) => app.group === group).length;

    if (count === 0) throw new Error(`Missing implementation for group "${group.name}"`);

    if (count > 1) throw new Error(`Duplicate implementation for group "${group.name}"`);
  }

  return erasedGroups(binding, openapiPath).pipe(
    Layer.provide(Layer.mergeAll(Layer.empty, ...groups)),
  );
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
  const Mount extends `/${string}` = `/${string}`,
>(groups: G, options: Options<Errors, Mount>): Http<Each<G>, Errors, Mount>;
export function make(
  groups: OneOrMore<Actions>,
  options: ErasedOptions,
): Http<Actions, ReadonlyArray<Action.Codec>> {
  const all = "actions" in groups ? [groups] : groups;

  const views = served(all, (action) => action.http);

  // A group's name is its identity here: native group identifier, OpenAPI tag
  // and mounted marker. Served actions become routes and client methods.
  assertDistinct(
    "action group",
    all.map((group) => group.name),
  );
  assertDistinct(
    "action",
    views.flatMap(({ actions }) => actions.map((action) => action.name)),
  );

  const api = erasedApi(views, options);

  // Unique per adapter, so a group layer of another adapter fails at build, never cross-wires.
  const id = ++bindings;

  let document: HttpServerResponse.HttpServerResponse | undefined;

  const binding: Binding = {
    views,
    options,
    mounted: new Map(
      all.map((group) => [
        group,
        Context.Service<Mounted<`/${string}`, string>, true>(
          `effect-actions/http/Mounted#${id}${options.apiPath}/${group.name}`,
        ),
      ]),
    ),
    schemaErrors: schemaErrorMiddleware(options.schemaError),
    document: () => (document ??= HttpServerResponse.jsonUnsafe(OpenApi.fromApi(api))),
  };

  return {
    api,
    openapi: () => OpenApi.fromApi(api),
    layer: (apps: OneOrMore<AnyImplementation>, layerOptions: LayerOptions) =>
      erasedLayer(
        binding,
        apps instanceof Implementation ? [apps] : apps,
        layerOptions.openapiPath,
      ),
    group: (app: AnyImplementation) => erasedGroup(binding, app),
    groups: (layerOptions) => erasedGroups(binding, layerOptions.openapiPath),
    client: (connection) => erasedClient(api, views, connection),
  };
}
