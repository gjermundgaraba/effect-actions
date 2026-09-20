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
        Schema.toCodecJson<A["errors"][number] | E>,
        never
      >
    : never;

type ApiGroup<G extends Actions> = G extends Actions
  ? [Endpoint<G["actions"][number], never>] extends [never]
    ? never
    : HttpApiGroup.HttpApiGroup<G["name"], Endpoint<G["actions"][number], PolicyError<G>>>
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
    error: action.errors,
  }).annotate(OpenApi.Description, action.description);

type ErasedPolicy = SchemaErrorPolicy<ReadonlyArray<Action.Codec>>;

/** The native middleware declares the policy's errors on every endpoint it wraps. */
const schemaErrorMiddleware = (name: string, policy: ErasedPolicy) => {
  class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
    `effect-actions/http/SchemaErrors/${name}`,
    { error: policy.errors },
  ) {}

  return {
    SchemaErrors,
    layer: HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
      Effect.fail(policy.map(failure)),
    ),
  };
};

/** A group's native projection, shared by the published API and every served one. */
interface Bound {
  readonly native: ApiGroup<Actions>;
  readonly policy: Layer.Layer<never>;
}

/** Groups without HTTP actions have no native projection. */
function bind(options: Options, group: Actions): Bound | undefined;
function bind(
  options: Options,
  group: Actions,
): { readonly native: HttpApiGroup.Constraint; readonly policy: Layer.Layer<never> } | undefined {
  const [first, ...rest] = httpActions(group).map((action) =>
    endpoint(options.apiPath, group, action),
  );

  if (first === undefined) return undefined;
  const native = HttpApiGroup.make(group.name).add(first, ...rest);

  if (group.schemaError === undefined) return { native, policy: Layer.empty };
  const policy = schemaErrorMiddleware(group.name, group.schemaError);

  return { native: native.middleware(policy.SchemaErrors), policy: policy.layer };
}

function apiOf(groups: ReadonlyArray<ApiGroup<Actions>>): Api<Actions>;
function apiOf(groups: ReadonlyArray<ApiGroup<Actions>>): HttpApi.Constraint {
  const [first, ...rest] = groups;
  const empty = HttpApi.make("actions").annotate(HttpApi.ParseOptions, { errors: "all" });

  return first === undefined ? empty : empty.add(first, ...rest);
}

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

/** Register one group's handlers. Handler erasure is limited to native dynamic endpoint registration. */
const groupHandlers = <G extends Actions, H, EX, RX>(
  api: Api<Actions>,
  app: Implementation<G, H, EX, RX>,
  policy: Layer.Layer<never>,
) => {
  const entries = (record: Handlers<HandlersContext<H>>) =>
    Object.fromEntries(
      httpActions(app.group).map((action) => [
        action.name,
        (request: { readonly payload: ErasedValue }) =>
          dispatch(app.group, action, record)(request.payload),
      ]),
    );

  return Layer.unwrap(
    Effect.map(app.build, (record) =>
      HttpApiBuilder.group(api, app.group.name, (builder) =>
        builder.handleAll(entries(erasedHandlers(record))),
      ),
    ),
  ).pipe(Layer.provide(policy));
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

  const bound = new Map(
    groups.flatMap((group): Array<[Actions, Bound]> => {
      const binding = bind(options, group);

      return binding === undefined ? [] : [[group, binding]];
    }),
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

    const served = apps.flatMap((app) => {
      const binding = bound.get(app.group);

      return binding === undefined ? [] : [{ app, ...binding }];
    });

    const api = apiOf(served.map(({ native }) => native));

    const merged = served.reduce<Layer.Layer<never, any, any>>(
      (layer, { app, policy }) => layer.pipe(Layer.provide(groupHandlers(api, app, policy))),
      HttpApiBuilder.layer(api),
    );

    // SAFETY: every `groupHandlers` is built from exactly one app's `build`; its
    // runtime services and failures are therefore the union of this tuple.
    // The adapter's router/platform services are added by `HttpApiBuilder.layer`.
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

  return { groups, api: apiOf([...bound.values()].map(({ native }) => native)), layer };
}
