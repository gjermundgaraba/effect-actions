import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { NoteStore } from "./notes/store.js";
import { requestScopedRoutes } from "./routes.js";

// Entrypoint for a host that calls `fetch` per request and runs nothing between requests, such
// as Cloudflare Workers, which takes this default export. The handler is built once, when the
// module loads, as Effect's `HttpRouter.toWebHandler` asks on Workers: a build started inside
// `fetch` would belong to that request. Building these routes does no I/O, which Workers refuses
// outside a request. `toWebHandler` reads no `MaxBodySize`, so the host limits request bodies.
const app = HttpRouter.toWebHandler(
  requestScopedRoutes.pipe(
    // DEMO ONLY: each instance of the worker holds notes of its own, lost when it stops. A
    // deployment provides a store every instance reaches.
    Layer.provide(NoteStore.layerMemory),
    Layer.provide(HttpServer.layerServices),
  ),
);

export default { fetch: (request: Request) => app.handler(request) };
