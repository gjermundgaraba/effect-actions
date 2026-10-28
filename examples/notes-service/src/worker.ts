import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { NoteStore } from "./notes/store.js";
import { requestScopedRoutes } from "./routes.js";

const app = HttpRouter.toWebHandler(
  requestScopedRoutes.pipe(
    Layer.provide(NoteStore.layerMemory),
    Layer.provide(HttpServer.layerServices)
  )
);

export default {
  fetch: async (request: Request) => await app.handler(request),
};
