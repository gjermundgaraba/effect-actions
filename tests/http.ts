import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { type Action, type ActionGroup, ActionHttp, ActionMcp } from "../src/index.js";
import { layer } from "../examples/app.js";

// Each call builds fresh example state.
export const makeTestApp = () =>
  HttpRouter.toWebHandler(layer.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

/** Serve an implementation over HTTP; `request` supplies its per-request services. */
export const makeTestHttp = <Actions extends ReadonlyArray<Action.Any>, R, EX>(
  app: ActionGroup.Implementation<Actions, R, EX, never>,
  request: Layer.Layer<NoInfer<R>>,
  options?: ActionHttp.Options,
) =>
  HttpRouter.toWebHandler(
    ActionHttp.layer(app, options).pipe(
      HttpRouter.provideRequest(request),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

/** Serve an implementation over MCP at /mcp; `request` supplies its per-request services. */
export const makeTestMcp = <Actions extends ReadonlyArray<Action.Any>, R, EX>(
  app: ActionGroup.Implementation<Actions, R, EX, never>,
  request: Layer.Layer<NoInfer<R>>,
) =>
  HttpRouter.toWebHandler(
    ActionMcp.layer(app, { name: "test", version: "0" }).pipe(
      HttpRouter.provideRequest(request),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
