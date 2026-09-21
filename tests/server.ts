import { McpProtocol } from "effect/unstable/ai";
import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import type * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import type { BeforeContext, HandlersContext } from "../src/internal/implementation.js";
import { layer } from "../examples/app.js";

/** Test-local mount paths; production callers must pass their own. */
export const testApiPath = "/api/actions" as const;

export const testMcpPath = "/mcp" as const;

export const testMcpUrl = "http://localhost/mcp";

// Each call builds fresh example state.
export const makeTestApp = () =>
  HttpRouter.toWebHandler(layer.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

/** Serve an implementation over HTTP; `request` supplies its per-request services. */
export const makeTestHttp = <Group extends ActionGroup.Any, H, EX, RB>(
  app: ActionGroup.Implementation<Group, H, EX, never, RB>,
  request: Layer.Layer<
    NoInfer<HandlersContext<H> | BeforeContext<ActionGroup.Implementation<Group, H, EX, never, RB>>>
  >,
  options?: { readonly apiPath?: `/${string}` },
) =>
  HttpRouter.toWebHandler(
    ActionHttp.make({ apiPath: options?.apiPath ?? testApiPath }, app.group)
      .layer(app)
      .pipe(HttpRouter.provideRequest(request), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

/** Serve an implementation over MCP; `request` supplies its per-request services. */
export const makeTestMcp = <Group extends ActionGroup.Any, H, EX, RB>(
  app: ActionGroup.Implementation<Group, H, EX, never, RB>,
  request: Layer.Layer<
    NoInfer<HandlersContext<H> | BeforeContext<ActionGroup.Implementation<Group, H, EX, never, RB>>>
  >,
) =>
  HttpRouter.toWebHandler(
    ActionMcp.layerHttp(
      { protocols: [McpProtocol.v2026_07_28], name: "test", version: "0", path: testMcpPath },
      app,
    ).pipe(HttpRouter.provideRequest(request), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
