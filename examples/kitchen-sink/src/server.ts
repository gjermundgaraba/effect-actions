import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { memory } from "./memory.js";
import { adminRoutes, builders, publicRoutes } from "./routes.js";

// Entrypoint: `node --import tsx examples/kitchen-sink/src/server.ts`.
// The composition root of the server: two listeners over one set of builders and services.
const server = Layer.unwrap(
  Effect.gen(function* () {
    const publicPort = yield* Config.Port("PORT").pipe(Config.withDefault(3000));
    const adminPort = yield* Config.Port("ADMIN_PORT").pipe(Config.withDefault(3001));

    const listen = (port: number) =>
      NodeHttpServer.layer(createServer, { host: "127.0.0.1", port });

    return Layer.mergeAll(
      // Two audiences, two listeners. Each `HttpRouter.serve` builds its routes in a layer
      // graph of its own, with a router of its own: the public port can only ever reach the
      // members' routes, and nothing built inside one is shared with the other.
      HttpRouter.serve(publicRoutes).pipe(Layer.provide(listen(publicPort))),
      HttpRouter.serve(adminRoutes).pipe(Layer.provide(listen(adminPort))),
    ).pipe(
      // Request bodies have no size limit unless the host sets one. This covers every route
      // of both ports, the MCP endpoint included.
      Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1))),
      // So what both ports share is provided outside both, once: the builders, then the
      // services the builders, the verifiers and the quota are built from. A workspace an
      // operator suspends on one port is thereby refused on the other.
      Layer.provide(builders),
      Layer.provide(memory),
    );
  }),
);

// NodeRuntime handles signals: the scoped layers stop both listeners and release the services.
Layer.launch(server).pipe(NodeRuntime.runMain);
