import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { fakeFarm } from "./platform/fake-farm.js";
import { printFarm } from "./platform/print-farm.js";
import { routes } from "./routes.js";

// Entrypoint: `node --import tsx examples/mcp-tools/src/server.ts`, with FARM_URL, FARM_USER
// and FARM_PASSWORD set. MCP over HTTP, for clients that connect to a URL.
// These tools are public: no route asks for a token, so where the server listens is its access
// control, the loopback interface by default or a network only trusted clients are on. Tools
// that need a caller take a verifier, as docs/ActionMcp.md's "Protect tools" shows.
const server = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
      // Request bodies have no size limit unless the host sets one. A tool call is a few
      // short fields, so anything larger is not one.
      Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(64))),
      // DEMO ONLY: `fakeFarm` answers the farm's API in memory. A real server provides
      // `FetchHttpClient.layer` in its place, and `printFarm` calls the farm at FARM_URL.
      Layer.provide(printFarm.pipe(Layer.provide(fakeFarm))),
    );
  }),
);

Layer.launch(server).pipe(NodeRuntime.runMain);
