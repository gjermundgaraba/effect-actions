import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import type { AnyImplementation, RequestContext } from "../src/internal/implementation.js";
import { layer } from "../examples/app.js";

/** The default HTTP mount path. */
export const testApiPath = "/api" as const;

/** The default MCP endpoint path. */
export const testMcpPath = "/mcp" as const;

export const testMcpUrl = "http://localhost/mcp";

// Each call builds fresh example state.
export const makeTestApp = () =>
  HttpRouter.toWebHandler(layer.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

/**
 * Serve implementations over HTTP, from a binding of exactly their actions;
 * `request` supplies their per-request services.
 */
export const makeTestHttp = <const Apps extends ReadonlyArray<AnyImplementation>>(
  apps: readonly [...Apps],
  request: Layer.Layer<NoInfer<RequestContext<Apps[number]>>>,
  options?: ActionHttp.Options,
) =>
  HttpRouter.toWebHandler(
    ActionHttp.make(
      apps.map((app) => app.action),
      options,
    )
      .layer(apps)
      .pipe(HttpRouter.provideRequest(request), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );

/** Serve implementations over MCP at `/mcp`; `request` supplies their per-request services. */
export const makeTestMcp = <const Apps extends ReadonlyArray<AnyImplementation>>(
  apps: readonly [...Apps],
  request: Layer.Layer<NoInfer<RequestContext<Apps[number]>>>,
) =>
  HttpRouter.toWebHandler(
    ActionMcp.layerHttp(apps, { name: "test", version: "0" }).pipe(
      HttpRouter.provideRequest(request),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
