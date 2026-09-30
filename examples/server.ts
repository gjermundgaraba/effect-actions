import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { layer } from "./app.js";

// NodeRuntime handles signals; scoped Layers stop the server and release services. Request
// bodies have no size limit unless the host sets one: this one covers every route. A job the
// process runs beside the routes goes in the served layer, `Layer.mergeAll(layer, job)`, to
// share their builders and `Users`: merged beside `HttpRouter.serve`, it may build its own.
HttpRouter.serve(layer).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 3000 })),
  Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1))),
  Layer.launch,
  NodeRuntime.runMain,
);
