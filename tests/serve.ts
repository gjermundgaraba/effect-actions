import { Effect, Layer, Predicate } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as ActionHttpClient from "../src/ActionHttpClient.js";
import type { AnyHttp, Client } from "../src/internal/client.js";
import { clientOf, type Served } from "../src/internal/memory.js";
import * as Testing from "../src/Testing.js";

/** A web handler, such as `HttpRouter.toWebHandler(routes).handler`. */
export type Handler = (request: Request) => Promise<Response>;

/** Served routes in memory: their web handler, and how to release them. */
export interface Server {
  readonly handler: Handler;
  readonly dispose: () => Promise<void>;
}

/**
 * Serve `routes` in memory, without a network or request logs, for tests that send raw
 * requests. `Testing.layer` is the public form, answering an `HttpClient` instead.
 */
export function serve<A, E, R extends Served>(routes: Layer.Layer<A, E, R>): Server;
export function serve(routes: Layer.Layer<unknown, unknown, Served>): Server {
  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  return { handler: (request) => web.handler(request), dispose: web.dispose };
}

const handlerOf = (target: Server | Handler): Handler =>
  Predicate.isFunction(target) ? target : target.handler;

/** `ActionHttpClient.make` for the binding, calling `server` in memory. */
export const httpClient = <const H extends AnyHttp>(
  http: H,
  server: Server | Handler,
  options?: Parameters<typeof ActionHttpClient.make>[1],
): Effect.Effect<Client<H>> =>
  ActionHttpClient.make(http, options).pipe(Effect.provide(clientOf(handlerOf(server))));

/** `Testing.mcpCall` against `server`, as a Promise that rejects with its failure. */
export const mcpCall = (
  server: Server | Handler,
  options: Parameters<typeof Testing.mcpCall>[0],
): Promise<Testing.McpCallResult> =>
  Effect.runPromise(Testing.mcpCall(options).pipe(Effect.provide(clientOf(handlerOf(server)))));
