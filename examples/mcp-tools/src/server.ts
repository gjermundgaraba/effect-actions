import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";

import { fakeFarm } from "./platform/fake-farm.js";
import { printFarm } from "./platform/print-farm.js";
import { routes } from "./routes.js";

const server = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Config.String("HOST").pipe(
      Config.withDefault("127.0.0.1")
    );

    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
      Layer.provide(
        Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(64))
      ),
      Layer.provide(printFarm.pipe(Layer.provide(fakeFarm)))
    );
  })
);

Layer.launch(server).pipe(NodeRuntime.runMain());
