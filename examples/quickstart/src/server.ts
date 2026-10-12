import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { routes } from "./routes.js";

// Entrypoint: `node --import tsx examples/quickstart/src/server.ts`.
// A real server reads its port from config and limits request bodies: see
// examples/notes-service/src/server.ts. `127.0.0.1` serves this machine alone: a server others
// reach binds another host, read from config as examples/mcp-tools/src/server.ts reads it.
HttpRouter.serve(routes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 3000 })),
  Layer.launch,
  NodeRuntime.runMain,
);
