import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { routes } from "./routes.js";

// Entrypoint: `node --import tsx examples/quickstart/src/server.ts`.
// A real server reads its port from config, `Config.Port("PORT")`, and limits request bodies:
// `Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1)))`.
// `127.0.0.1` serves this machine alone: a server others reach reads its host from config,
// `Config.String("HOST").pipe(Config.withDefault("127.0.0.1"))`.
HttpRouter.serve(routes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 3000 })),
  Layer.launch,
  NodeRuntime.runMain,
);
