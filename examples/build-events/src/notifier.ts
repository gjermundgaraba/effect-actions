import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Config, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";

import { Notices } from "./notifier/Notices.js";
import { notifier } from "./notifier/routes.js";

const server = Layer.unwrap(
  Effect.gen(function* () {
    const buildEvents = yield* Config.String("BUILDS_URL").pipe(
      Config.withDefault("http://127.0.0.1:3000")
    );

    const token = yield* Config.Redacted("BUILDS_TOKEN");
    const publicUrl = yield* Config.String("PUBLIC_URL");

    const host = yield* Config.String("HOST").pipe(
      Config.withDefault("127.0.0.1")
    );

    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3001));

    return HttpRouter.serve(notifier({ buildEvents, token, publicUrl })).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
      Layer.provide(
        Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(256))
      ),
      Layer.provide([
        Notices.layerMemory,
        KeyValueStore.layerMemory,
        FetchHttpClient.layer,
      ])
    );
  })
);

Layer.launch(server).pipe(NodeRuntime.runMain());
