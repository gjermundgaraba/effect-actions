import { onTestFinished } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as ActionHttp from "../src/ActionHttp.js";
import type { Served } from "../src/internal/memory.js";
import * as Testing from "../src/Testing.js";

/** A web handler, such as `HttpRouter.toWebHandler(routes).handler`. */
export type Handler = (request: Request) => Promise<Response>;

/** Served routes in memory: their web handler, and how to release them. */
export interface Server {
  readonly handler: Handler;
  readonly dispose: () => Promise<void>;
}

/** What routes may leave to `serveWithContext`: what `serve` admits, and request context. */
type Routable =
  | Served
  | HttpRouter.Request<"Requires", any>
  | HttpRouter.Request<"GlobalRequires", any>;

/**
 * Serve `routes` in memory, without a network or request logs, each request taking a
 * context: for tests that supply request services per request, or deliberately leave them
 * out, which `serve` refuses. They are released when the test finishes; a test may
 * release them sooner with `dispose`.
 */
export const serveWithContext = <A, E, R extends Routable>(routes: Layer.Layer<A, E, R>) => {
  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  onTestFinished(() => web.dispose());

  return web;
};

/**
 * Serve `routes` in memory, without a network or request logs, for tests that send raw
 * requests, released when the test finishes. `Testing.layer` is the public form, answering an `HttpClient` instead.
 */
export function serve<A, E, R extends Served>(routes: Layer.Layer<A, E, R>): Server;
export function serve(routes: Layer.Layer<unknown, unknown, Served>): Server {
  const web = serveWithContext(routes);

  return { handler: (request) => web.handler(request), dispose: web.dispose };
}

/** `ActionHttp.client` for the binding, calling `handler` in memory. */
export const httpClient = <const H extends ActionHttp.Any>(
  http: H,
  handler: Handler,
  options?: Parameters<typeof ActionHttp.client>[1],
): Effect.Effect<ActionHttp.Client<H>> =>
  ActionHttp.client(http, options).pipe(Effect.provide(Testing.layer(handler)));
