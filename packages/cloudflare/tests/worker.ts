import { DurableObject } from "cloudflare:workers";
import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { routes } from "./support/app.js";

export class Plain extends DurableObject {
  readonly web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  override fetch(request: Request) {
    return this.web.handler(request);
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
