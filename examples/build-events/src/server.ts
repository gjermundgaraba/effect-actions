import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { BuildStore } from "./builds/store.js";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Approvers } from "./deploys/approvers.js";
import { routes } from "./routes.js";

// Entrypoint: `node --import tsx examples/build-events/src/server.ts`.
// It chooses the stores, reads the configuration and starts Node's HTTP server.
const server = Layer.unwrap(
  Effect.gen(function* () {
    // The loopback default serves this machine alone; HOST=0.0.0.0 lets others reach it.
    const host = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
      // Request bodies have no size limit unless the host sets one. This covers every route
      // that reads its body whole, the MCP endpoint included.
      Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1))),
      // DEMO ONLY: builds and approvers live in this process's memory; a deployment provides
      // stores that last.
      Layer.provide([BuildStore.layerMemory, Approvers.layerMemory]),
      // The events this process announces: a notify after a build finishes, and each deploy
      // request published. One for the whole server, which holds every subscriber's connection.
      Layer.provide(Event.layerMemory),
    );
  }),
);

Layer.launch(server).pipe(NodeRuntime.runMain);
