import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";

import { routes } from "./routes.js";

const demoListen = { host: "127.0.0.1", port: 3000 };

HttpRouter.serve(routes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, demoListen)),
  Layer.launch,
  NodeRuntime.runMain()
);
