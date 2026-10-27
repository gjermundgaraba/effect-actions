import { onTestFinished } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import * as ActionHttp from "../../src/http/ActionHttp.js";
import type { Served } from "../../src/testing/memory.js";
import * as Testing from "../../src/testing/Testing.js";

export type Handler = (request: Request) => Promise<Response>;

export interface Server {
  readonly handler: Handler;
  readonly dispose: () => Promise<void>;
}

type ServedOrRequestContext =
  | Served
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", unknown>;

export const serveWithContext = <A, E, R extends ServedOrRequestContext>(
  routes: Layer.Layer<A, E, R>
) => {
  const web = HttpRouter.toWebHandler(
    routes.pipe(Layer.provide(HttpServer.layerServices)),
    {
      disableLogger: true,
    }
  );

  onTestFinished(async () => {
    await web.dispose();
  });

  return web;
};

export function serve<A, E, R extends Served>(
  routes: Layer.Layer<A, E, R>
): Server;
export function serve<E>(routes: Layer.Layer<unknown, E, Served>): Server {
  const web = serveWithContext(routes);

  return {
    handler: async (request) => await web.handler(request),
    dispose: web.dispose,
  };
}

export const httpClient = <const H extends ActionHttp.Any>(
  http: H,
  handler: Handler,
  options?: ActionHttp.ClientOptions
): Effect.Effect<ActionHttp.Client<H>> =>
  ActionHttp.client(http, options).pipe(Effect.provide(Testing.layer(handler)));
