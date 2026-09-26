import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import {
  type AuthenticatedContext,
  type Member,
  type Served,
  toList,
} from "../src/internal/implementation.js";
import { layer } from "../examples/app.js";
import { serve } from "./serve.js";

// Each call builds fresh example state.
export const makeTestApp = () => serve(layer);

/** What routes may leave to `serveWithContext`: the router, the platform, request context. */
type Routable =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Requires", any>
  | HttpRouter.Request<"GlobalRequires", any>
  | HttpRouter.Request<"Error", any>
  | HttpRouter.Request<"GlobalError", any>
  | Layer.Success<typeof HttpServer.layerServices>;

/**
 * `Testing.serve`, except that each request takes a context: for tests that supply
 * request services per request, or deliberately leave them out. `Testing.serve` requires
 * routes to satisfy them, so it cannot.
 */
export const serveWithContext = <A, E, R extends Routable>(routes: Layer.Layer<A, E, R>) =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

/**
 * Serve implementations over HTTP, from a binding of exactly their actions;
 * `request` supplies their per-request services.
 */
export const makeTestHttp = <const Apps extends Served>(
  apps: Apps,
  request: Layer.Layer<NoInfer<AuthenticatedContext<Member<Apps>>>>,
  options?: Parameters<typeof ActionHttp.make>[1],
) =>
  serve(
    ActionHttp.layer(
      ActionHttp.make(
        toList(apps).flatMap((app) => app.actions),
        options,
      ),
      apps,
    ).pipe(HttpRouter.provideRequest(request)),
  );

/** Serve implementations over MCP at `/mcp`; `request` supplies their per-request services. */
export const makeTestMcp = <const Apps extends Served>(
  apps: Apps,
  request: Layer.Layer<NoInfer<AuthenticatedContext<Member<Apps>>>>,
) =>
  serve(
    ActionMcp.layerHttp(apps, { name: "test", version: "0" }).pipe(
      HttpRouter.provideRequest(request),
    ),
  );
