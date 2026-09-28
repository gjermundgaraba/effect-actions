import { onTestFinished } from "vite-plus/test";
import { Effect, Layer, Predicate } from "effect";
import { type HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import * as ActionHttp from "../src/ActionHttp.js";
import type { AnyHttp, Client } from "../src/internal/client.js";
import { clientOf, type Served } from "../src/internal/memory.js";

/** A web handler, such as `HttpRouter.toWebHandler(routes).handler`. */
export type Handler = (request: Request) => Promise<Response>;

/** Served routes in memory: their web handler, and how to release them. */
export interface Server {
  readonly handler: Handler;
  readonly dispose: () => Promise<void>;
}

/** What routes may leave to `serveWithContext`: the router, the platform, request context. */
type Routable =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Requires", any>
  | HttpRouter.Request<"GlobalRequires", any>
  | HttpRouter.Request<"Error", any>
  | HttpRouter.Request<"GlobalError", any>
  | Layer.Success<typeof HttpServer.layerServices>;

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

const handlerOf = (target: Server | Handler): Handler =>
  Predicate.isFunction(target) ? target : target.handler;

/** `ActionHttp.client` for the binding, calling `server` in memory. */
export const httpClient = <const H extends AnyHttp>(
  http: H,
  server: Server | Handler,
  options?: Parameters<typeof ActionHttp.client>[1],
): Effect.Effect<Client<H>> =>
  ActionHttp.client(http, options).pipe(Effect.provide(clientLayer(server)));

/** The native `HttpClient`, answered by `server` in memory, as `Testing.layer` answers it. */
export const clientLayer = (server: Server | Handler): Layer.Layer<HttpClient.HttpClient> =>
  clientOf(handlerOf(server));

/** `effect`, such as a `Testing.mcpClient`, on an `HttpClient` answered by `server` in memory. */
export const against = <A, E>(
  server: Server | Handler,
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(clientLayer(server))));
