import { Context, Effect, Layer } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import type * as Action from "./Action.js";
import { handlerFor, Implementation } from "./internal/implementation.js";

export interface Options {
  readonly prefix?: `/${string}`;
  readonly openapiPath?: `/${string}`;
}

/** A group or its implementation. */
export interface Actions {
  readonly actions: ReadonlyArray<Action.Any>;
}

// HttpApi decodes the payload with the full input codec, encodes the result with
// the success codec, and renders each declared error by its status annotation.
const endpoint = (prefix: `/${string}`, action: Action.Any) =>
  HttpApiEndpoint.post(action.name, `${prefix}/${action.name}`, {
    payload: action.input,
    success: action.success,
    error: [...action.errors],
  }).annotate(OpenApi.Description, action.description);

/** The native `HttpApi` for every HTTP-enabled action: `POST <prefix>/<name>`. */
export const api = (group: Actions, options: Options = {}) => {
  const prefix = options.prefix ?? "/api/actions";
  const [first, ...rest] = group.actions
    .filter((action) => action.http)
    .map((action) => endpoint(prefix, action));
  if (first === undefined) throw new Error("No HTTP-enabled actions");
  return HttpApi.make("actions").add(HttpApiGroup.make("actions").add(first, ...rest));
};

/** The OpenAPI 3.1 document Effect derives from `api`. */
export const openapi = (group: Actions, options: Options = {}) =>
  OpenApi.fromApi(api(group, options));

/**
 * Register the endpoints and `GET /openapi.json` on the router. Handler
 * requirements are request-level requirements, exactly as native
 * `HttpApiBuilder` handlers' are. Groups with no HTTP action register nothing.
 */
export const layer = <Actions extends ReadonlyArray<Action.Any>, R, EX, RX>(
  app: Implementation<Actions, R, EX, RX>,
  options: Options = {},
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
  const httpApi = api(app, options);
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
      Layer.buildWithMemoMap(group, memoMap, scope).pipe(Effect.setContext(Context.empty())),
    );
    return HttpApiBuilder.layer(httpApi, {
      openapiPath: options.openapiPath ?? "/openapi.json",
    }).pipe(Layer.provide(isolated));
  });
};
