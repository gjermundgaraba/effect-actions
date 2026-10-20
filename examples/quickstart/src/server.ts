import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { routes } from "./routes.js";

// Entrypoint: `node --import tsx examples/quickstart/src/server.ts`.
// DEMO ONLY: a deployed server reads its host and port from config and limits request bodies,
// as notes-service/src/server.ts does; `127.0.0.1` serves this machine alone.
HttpRouter.serve(routes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 3000 })),
  Layer.launch,
  NodeRuntime.runMain,
);
