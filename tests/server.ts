import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { type Action, type ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";
import { layer } from "../examples/app.js";

/** Test-local mount paths; production callers must pass their own. */
export const testApiPath = "/api/actions" as const;

export const testOpenapiPath = "/openapi.json" as const;

export const testMcpPath = "/mcp" as const;

export const testMcpUrl = "http://localhost/mcp";

// Each call builds fresh example state.
export const makeTestApp = () =>
  HttpRouter.toWebHandler(layer.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

/** Serve an implementation over HTTP; `request` supplies its per-request services. */
export const makeTestHttp = <Actions extends ReadonlyArray<Action.Any>, R, EX>(
  app: ActionGroup.Implementation<Actions, R, EX, never>,
  request: Layer.Layer<NoInfer<R>>,
  options?: Partial<ActionHttp.Options & ActionHttp.LayerOptions>,
) =>
  HttpRouter.toWebHandler(
    ActionHttp.make(app.group, { apiPath: options?.apiPath ?? testApiPath })
      .layer(app, { openapiPath: options?.openapiPath ?? testOpenapiPath })
      .pipe(HttpRouter.provideRequest(request), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

/** Serve an implementation over MCP; `request` supplies its per-request services. */
export const makeTestMcp = <Actions extends ReadonlyArray<Action.Any>, R, EX>(
  app: ActionGroup.Implementation<Actions, R, EX, never>,
  request: Layer.Layer<NoInfer<R>>,
) =>
  HttpRouter.toWebHandler(
    ActionMcp.layer(app, { name: "test", version: "0", path: testMcpPath }).pipe(
      HttpRouter.provideRequest(request),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
