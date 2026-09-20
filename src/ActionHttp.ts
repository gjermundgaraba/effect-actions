import { Effect, Layer, type Schema, type SchemaAST } from "effect";
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
import type { SchemaErrorPolicy } from "./ActionGroup.js";
import { type Actions, assertDistinct, type PolicyError } from "./internal/actions.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  dispatch,
  type ErasedValue,
  type Handlers,
  type HandlersContext,
  Implementation,
  type RequestContext,
} from "./internal/implementation.js";

/** Contract-level configuration: servers and clients must agree on it. */
export interface Options {
  readonly apiPath: `/${string}`;
}

type Endpoint<A extends Action.Any, E extends Action.Codec, Middleware = never> = A extends {
  readonly http: false;
}
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
        Schema.toCodecJson<A["errors"][number] | E>,
        Middleware
      >
    : never;

type ApiGroup<G extends Actions, Middleware = never> = G extends Actions
  ? [Endpoint<G["actions"][number], never>] extends [never]
    ? never
    : HttpApiGroup.HttpApiGroup<
        G["name"],
        Endpoint<G["actions"][number], PolicyError<G>, Middleware>
      >
  : never;

/** The native `HttpApi` of every HTTP-enabled action of `G`, one group per action group. */
export type Api<G extends Actions> = HttpApi.HttpApi<"actions", ApiGroup<G>>;

/** A namespaced HTTP binding. */
export interface Http<Groups extends ReadonlyArray<Actions>> {
  /** The exact contracts bound to this HTTP adapter, in declaration order. */
  readonly groups: Groups;
  readonly api: Api<Groups[number]>;
  /**
   * Serve any number of implementations in one layer. Build failures, build
   * services and request services are unions over precisely those apps.
   */
  readonly layer: <const Apps extends ReadonlyArray<AnyImplementation<Groups[number]>>>(
    ...apps: Apps
  ) => Layer.Layer<
    never,
    BuildError<Apps[number]>,
    | BuildContext<Apps[number]>
    | HttpRouter.HttpRouter
    | HttpRouter.Request.From<"Requires", RequestContext<Apps[number]>>
    | Etag.Generator
    | FileSystem
    | HttpPlatform.HttpPlatform
    | Path
  >;
}

const httpActions = (group: Actions) => group.actions.filter((action) => action.http);

const endpoint = (apiPath: `/${string}`, group: Actions, action: Action.Any) =>
  HttpApiEndpoint.post(action.name, `${apiPath}/${group.name}/${action.name}`, {
    payload: action.input,
    success: action.success,
    error: [...action.errors, ...(group.schemaError?.errors ?? [])],
  }).annotate(OpenApi.Description, action.description);

/** A policy maps issues, so it receives every issue and the input each one rejected. */
const policyParseOptions: SchemaAST.ParseOptions = { errors: "all", reportInput: true };

function erasedApi(groups: ReadonlyArray<Actions>, options: Options): Api<Actions>;
function erasedApi(groups: ReadonlyArray<Actions>, options: Options): HttpApi.Constraint {
  const made = groups.flatMap((group) => {
    const [first, ...rest] = httpActions(group).map((action) =>
      endpoint(options.apiPath, group, action),
    );

    if (first === undefined) return [];
    const httpGroup = HttpApiGroup.make(group.name).add(first, ...rest);

    return [
      group.schemaError === undefined
        ? httpGroup
        : httpGroup.annotate(HttpApi.ParseOptions, policyParseOptions),
    ];
  });

  const [first, ...rest] = made;
  const empty = HttpApi.make("actions");

  return first === undefined ? empty : empty.add(first, ...rest);
}

type ErasedPolicy = SchemaErrorPolicy<ReadonlyArray<Action.Codec>>;

const schemaErrorMiddleware = (policy: ErasedPolicy) => {
  class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
    "effect-actions/http/SchemaErrors",
    { error: policy.errors },
  ) {}

  return {
    SchemaErrors,
    layer: HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
      Effect.fail(policy.map(failure)),
    ),
  };
};

/**
 * `HttpApiBuilder.handleAll` registers a dynamically assembled record. The
 * action selected by the native router determines the input before `dispatch`
 * calls its handler, so this is the one adapter boundary where exact handlers
 * are viewed as an erased record. `HandlersContext` remains on the dispatch
 * effect and is restored by `Http.layer`'s public signature.
 */
const erasedHandlers = <H>(handlers: H): Handlers<HandlersContext<H>> => {
  // SAFETY: dynamic native endpoint registration selects the matching action before invocation.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- See invariant above.
  return handlers as Handlers<HandlersContext<H>>;
};

/** Build routes for one group. Handler erasure is limited to native dynamic endpoint registration. */
const groupLayer = <G extends Actions, H, EX, RX>(
  options: Options,
  app: Implementation<G, H, EX, RX>,
) => {
  const actions = httpActions(app.group);

  if (actions.length === 0) return Layer.empty;

  const entries = (record: Handlers<HandlersContext<H>>) =>
    Object.fromEntries(
      actions.map((action) => [
        action.name,
        (request: { readonly payload: ErasedValue }) =>
          dispatch(app.group, action, record)(request.payload),
      ]),
    );

  /** Register every action on `api` once handlers are built; the policy widens endpoint middleware. */
  const serve = <Middleware>(
    api: HttpApi.HttpApi<"actions", ApiGroup<Actions, Middleware>>,
    policy: Layer.Layer<never> = Layer.empty,
  ) =>
    Layer.unwrap(
      Effect.map(app.build, (record) =>
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(
            HttpApiBuilder.group(api, app.group.name, (builder) =>
              builder.handleAll(entries(erasedHandlers(record))),
            ),
          ),
          Layer.provide(policy),
        ),
      ),
    );

  const api = erasedApi([app.group], options);

  if (app.group.schemaError === undefined) return serve(api);

  const schemaErrors = schemaErrorMiddleware(app.group.schemaError);

  return serve(api.middleware(schemaErrors.SchemaErrors), schemaErrors.layer);
};

/**
 * Bind the contract-level configuration once. Every route is `POST
 * <apiPath>/<group>/<action>`, so action names may repeat across groups.
 */
export function make<const G extends ReadonlyArray<Actions>>(
  options: Options,
  ...groups: G
): Http<G>;
export function make(
  options: Options,
  ...groups: ReadonlyArray<Actions>
): Http<ReadonlyArray<Actions>> {
  assertDistinct(
    "action group",
    groups.map((group) => group.name),
  );

  const layer = <const Apps extends ReadonlyArray<AnyImplementation>>(
    ...apps: Apps
  ): Layer.Layer<
    never,
    BuildError<Apps[number]>,
    | BuildContext<Apps[number]>
    | HttpRouter.HttpRouter
    | HttpRouter.Request.From<"Requires", RequestContext<Apps[number]>>
    | Etag.Generator
    | FileSystem
    | HttpPlatform.HttpPlatform
    | Path
  > => {
    assertDistinct(
      "implementation group",
      apps.map((app) => app.group.name),
    );

    for (const app of apps) {
      if (!groups.includes(app.group)) {
        throw new Error(
          `Implementation of group "${app.group.name}" is not served by this adapter`,
        );
      }
    }

    const merged = apps
      .map((app) => groupLayer(options, app))
      .reduce<Layer.Layer<never, any, any>>((all, app) => Layer.merge(all, app), Layer.empty);

    // SAFETY: every `groupLayer` is built from exactly one app's `build`; its
    // runtime services and failures are therefore the union of this tuple.
    // The adapter's router/platform services are added by `groupLayer`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic tuple reduction cannot express the same union as the public variadic signature.
    return merged as Layer.Layer<
      never,
      BuildError<Apps[number]>,
      | BuildContext<Apps[number]>
      | HttpRouter.HttpRouter
      | HttpRouter.Request.From<"Requires", RequestContext<Apps[number]>>
      | Etag.Generator
      | FileSystem
      | HttpPlatform.HttpPlatform
      | Path
    >;
  };

  return { groups, api: erasedApi(groups, options), layer };
}
