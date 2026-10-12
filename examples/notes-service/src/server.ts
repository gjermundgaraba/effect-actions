import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { NoteStore } from "./notes/store.js";
import { routes } from "./routes.js";

// Entrypoint: `node --import tsx examples/notes-service/src/server.ts`.
// This is the composition root of the server. It chooses the store, reads the configuration
// and starts Node's HTTP server; nothing below it knows which of those it got.
const server = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })),
      // Request bodies have no size limit unless the host sets one. This covers every route.
      Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1))),
      Layer.provide(NoteStore.layerMemory),
    );
  }),
);

Layer.launch(server).pipe(NodeRuntime.runMain);
