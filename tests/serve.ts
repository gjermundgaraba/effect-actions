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

/** `ActionHttp.client` for the binding, calling `server` in memory. */
export const httpClient = <const H extends AnyHttp>(
  http: H,
  server: Server | Handler,
  options?: Parameters<typeof ActionHttp.client>[1],
): Effect.Effect<Client<H>> =>
  ActionHttp.client(http, options).pipe(Effect.provide(clientOf(handlerOf(server))));

/** `effect`, such as a `Testing.mcpCall`, on an `HttpClient` answered by `server` in memory. */
export const against = <A, E>(
  server: Server | Handler,
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(clientOf(handlerOf(server)))));
