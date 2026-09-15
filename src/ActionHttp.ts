import { Context, Effect, Layer, type Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiMiddleware,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import type * as Action from "./Action.js";
import { handlerFor, Implementation } from "./internal/implementation.js";

/** Service-free HTTP error policy. The application owns the declared errors. */
export interface SchemaErrorPolicy<Errors extends ReadonlyArray<Action.Codec>> {
  readonly errors: Errors;
  readonly map: (failure: HttpApiError.HttpApiSchemaError) => NoInfer<Errors[number]["Type"]>;
}

export interface Options<Errors extends ReadonlyArray<Action.Codec> = []> {
  readonly schemaError?: SchemaErrorPolicy<Errors>;
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

// HttpApi decodes the payload with the full input codec, encodes the result with
// the success codec, and renders each declared error by its status annotation.
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
  const policy: SchemaErrorPolicy<ReadonlyArray<Action.Codec>> | undefined = options.schemaError;
  // Only this adapter-owned middleware enters the isolated native handler build.
  // Its pure mapping closure cannot resolve application services at startup.
  class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
    "effect-actions/http/SchemaErrors",
    { error: policy?.errors ?? [] },
  ) {}
  const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, (failure) =>
    Effect.fail(policy === undefined ? failure : policy.map(failure)),
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
    // Only the handler closure is needed. HttpApiBuilder must not capture the
    // application's build context and merge it over subsequent requests.
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
