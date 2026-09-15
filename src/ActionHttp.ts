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
import { handlerFor, Implementation } from "./internal/implementation.js";

export interface Options<Errors extends ReadonlyArray<Action.Codec> = []> {
  readonly schemaError?: Action.SchemaErrorPolicy<Errors>;
  readonly prefix?: `/${string}`;
  /** Set false when the host serves a combined document for multiple groups. */
  readonly openapiPath?: `/${string}` | false;
}

/** A group or its implementation. */
export interface Actions<A extends ReadonlyArray<Action.Any> = ReadonlyArray<Action.Any>> {
  readonly actions: A;
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

const endpoint = (prefix: `/${string}`, action: Action.Any, errors: ReadonlyArray<Action.Codec>) =>
  HttpApiEndpoint.post(action.name, `${prefix}/${action.name}`, {
    payload: action.input,
    success: action.success,
    error: [...action.errors, ...errors],
  }).annotate(OpenApi.Description, action.description);

/** The native `HttpApi` for every HTTP-enabled action: `POST <prefix>/<name>`. */
export function api<
  A extends ReadonlyArray<Action.Any>,
  Errors extends ReadonlyArray<Action.Codec> = [],
>(
  group: Actions<A>,
  options?: Options<Errors>,
): HttpApi.HttpApi<
  "actions",
  HttpApiGroup.HttpApiGroup<"actions", Endpoint<A[number], Errors[number]>>
>;
export function api(
  group: Actions,
  options: Options<ReadonlyArray<Action.Codec>> = {},
): HttpApi.Constraint {
  const prefix = options.prefix ?? "/api/actions";
  const [first, ...rest] = group.actions
    .filter((action) => action.http)
    .map((action) => endpoint(prefix, action, options.schemaError?.errors ?? []));
  if (first === undefined) throw new Error("No HTTP-enabled actions");
  return HttpApi.make("actions").add(HttpApiGroup.make("actions").add(first, ...rest));
}

/** The OpenAPI 3.1 document Effect derives from `api`. */
export const openapi = <Errors extends ReadonlyArray<Action.Codec> = []>(
  group: Actions,
  options: Options<Errors> = {},
) => OpenApi.fromApi(api(group, options));

/**
 * Register the endpoints and `GET /openapi.json` on the router. Handler
 * requirements are request-level requirements, exactly as native
 * `HttpApiBuilder` handlers' are. Groups with no HTTP action register nothing.
 */
export const layer = <
  Actions extends ReadonlyArray<Action.Any>,
  R,
  EX,
  RX,
  Errors extends ReadonlyArray<Action.Codec> = [],
>(
  app: Implementation<Actions, R, EX, RX>,
  options: Options<Errors> = {},
): Layer.Layer<
  never,
  EX,
  | RX
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", R>
  | Etag.Generator
  | FileSystem
  | HttpPlatform.HttpPlatform
  | Path
> => {
  const exposed = app.actions.filter((action) => action.http);
  if (exposed.length === 0) return Layer.empty;
  const policy: Action.SchemaErrorPolicy<ReadonlyArray<Action.Codec>> | undefined =
    options.schemaError;
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
  const httpApi = api<ReadonlyArray<Action.Any>, ReadonlyArray<Action.Codec>>(
    app,
    options,
  ).middleware(SchemaErrors);
  return Implementation.register(app, (table) => {
    const group = HttpApiBuilder.group(httpApi, "actions", (handlers) =>
      handlers.handleAll(
        Object.fromEntries(
          exposed.map((action) => {
            const handle = handlerFor(table, action);
            return [
              action.name,
              (request: { readonly payload: unknown }) => handle(request.payload),
            ];
          }),
        ),
      ),
    );
    // Build the native group with an empty context so build-time application
    // services cannot become request fallbacks.
    const isolated = Layer.fromBuildMemo((memoMap, scope) =>
      Layer.buildWithMemoMap(group.pipe(Layer.provide(schemaErrors)), memoMap, scope).pipe(
        Effect.setContext(Context.empty()),
      ),
    );
    return HttpApiBuilder.layer(httpApi, {
      openapiPath:
        options.openapiPath === false ? undefined : (options.openapiPath ?? "/openapi.json"),
    }).pipe(Layer.provide(isolated));
  });
};

type NativeClientOptions = NonNullable<Parameters<typeof HttpApiClient.make>[1]>;

/** Connection options plus the transport configuration used by HTTP clients. */
export type ClientOptions<Errors extends ReadonlyArray<Action.Codec> = []> = NativeClientOptions &
  Pick<Options<Errors>, "prefix" | "schemaError">;

/** Direct decoded-input methods, excluding MCP-only actions. */
export type Client<A extends ReadonlyArray<Action.Any>, E extends Action.Codec = never> = {
  readonly [Item in A[number] as Item["http"] extends false ? never : Item["name"]]: (
    ...args: {} extends Item["input"]["Type"]
      ? [input?: Item["input"]["Type"]]
      : [input: Item["input"]["Type"]]
  ) => HttpApiClient.Client.MethodReturn<Endpoint<Item, E>, never, never, "decoded-only">;
};

/** Bind transport configuration once for contracts, routes, documents and clients. */
export const configure = <Errors extends ReadonlyArray<Action.Codec> = []>(
  options: Options<Errors> = {},
) => ({
  api: <A extends ReadonlyArray<Action.Any>>(group: Actions<A>) => api(group, options),
  openapi: (group: Actions) => openapi(group, options),
  layer: <A extends ReadonlyArray<Action.Any>, R, EX, RX>(app: Implementation<A, R, EX, RX>) =>
    layer(app, options),
  client: <A extends ReadonlyArray<Action.Any>>(
    group: Actions<A>,
    { baseUrl, transformClient, transformResponse }: NativeClientOptions = {},
  ) => client(group, { ...options, baseUrl, transformClient, transformResponse }),
});

/** Direct action methods backed by the native HTTP client and its codecs. */
export function client<
  A extends ReadonlyArray<Action.Any>,
  Errors extends ReadonlyArray<Action.Codec> = [],
>(
  group: Actions<A>,
  options?: ClientOptions<Errors>,
): Effect.Effect<Client<A, Errors[number]>, never, HttpClient.HttpClient>;
export function client(
  group: Actions,
  options: ClientOptions<ReadonlyArray<Action.Codec>> = {},
): Effect.Effect<
  Readonly<Record<string, (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>>>,
  never,
  HttpClient.HttpClient
> {
  return Effect.map(HttpApiClient.make(api(group, options), options), (native) => {
    // Decide once from decoded input schemas: undefined is omitted input for
    // structs, but remains a value for codecs that explicitly accept it.
    const acceptsUndefined = new Set(
      group.actions
        .filter((action) => Schema.is(action.input)(undefined))
        .map((action) => action.name),
    );
    return Object.fromEntries(
      Object.entries(native.actions).map(([name, method]) => {
        // Callable "then" would make Promise resolution assimilate this client.
        if (name === "then")
          throw new Error('Action "then" requires the native grouped HttpApiClient');
        return [
          name,
          (input?: unknown) =>
            method({
              payload: input === undefined && !acceptsUndefined.has(name) ? {} : input,
              responseMode: "decoded-only",
            }),
        ];
      }),
    );
  });
}
