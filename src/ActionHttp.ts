import { Effect, Layer, type Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http";
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
  type Actions,
  assertDistinct,
  type PolicyError,
  type Served as View,
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
export interface Options {
  readonly apiPath: `/${string}`;
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
type ApiGroup<G extends Actions> = G extends Actions
  ? [Endpoint<G["actions"][number], never>] extends [never]
    ? never
    : HttpApiGroup.HttpApiGroup<G["name"], Endpoint<G["actions"][number], PolicyError<G>>>
  : never;

/** The native `HttpApi` of every HTTP-enabled action of `G`, one `HttpApiGroup` per group. */
export type Api<G extends Actions> = HttpApi.HttpApi<"actions", ApiGroup<G>>;

/** One HTTP binding: a native API and one route layer per group. */
export interface Http<G extends Actions> {
  /**
   * The native `HttpApi` for every HTTP-enabled action: `POST <apiPath>/<name>`.
   * Documents, documentation UIs and native clients are Effect's own, from this value.
   */
  readonly api: Api<G>;
  /**
   * The routes of one group. Merge one per group; router middleware provided
   * to a layer applies to that group only. Handler requirements are
   * request-level requirements, exactly as native `HttpApiBuilder` handlers'
   * are. A group without HTTP actions registers nothing and is not acquired.
   * Native context capture applies: never provide request-identity tags at startup.
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
}

const endpoint = (apiPath: `/${string}`, action: Action.Any, errors: ReadonlyArray<Action.Codec>) =>
  HttpApiEndpoint.post(action.name, `${apiPath}/${action.name}`, {
    payload: action.input,
    success: action.success,
    error: [...action.errors, ...errors],
  }).annotate(OpenApi.Description, action.description);

type ErasedPolicy = Action.SchemaErrorPolicy<ReadonlyArray<Action.Codec>>;

function erasedApi(views: ReadonlyArray<View>, options: Options): Api<Actions>;
function erasedApi(views: ReadonlyArray<View>, options: Options): HttpApi.Constraint {
  const [first, ...rest] = views.flatMap(({ group, actions }) => {
    const [head, ...tail] = actions.map((action) =>
      endpoint(options.apiPath, action, group.schemaError?.errors ?? []),
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
  readonly views: ReadonlyArray<View>;
  readonly options: Options;
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

  // The policy is the group's own, so groups of one adapter may answer differently.
  const schemaErrors = schemaErrorMiddleware(view.group.schemaError);
  const httpApi = erasedApi([view], binding.options).middleware(schemaErrors.SchemaErrors);

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

    return HttpApiBuilder.layer(httpApi).pipe(
      Layer.provide(
        Layer.mergeAll(Layer.empty, ...handlers).pipe(Layer.provide(schemaErrors.layer)),
      ),
    );
  });
};

/**
 * Bind the contract-level configuration once. The native API is built here and
 * shared by the routes and clients, so they cannot disagree. Duplicate group
 * names or HTTP action names across `groups` fail here.
 */
export function make<const G extends ReadonlyArray<Actions>>(
  options: Options,
  ...groups: G
): Http<G[number]>;
export function make(options: Options, ...groups: ReadonlyArray<Actions>): Http<Actions> {
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
  };

  return {
    api,
    layer: (app: AnyImplementation) => erasedLayer(binding, app),
  };
}
