import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Config, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";

import { Notices } from "./notifier/Notices.js";
import { notifier } from "./notifier/routes.js";

// Entrypoint of the second service: `BUILDS_TOKEN=grace PUBLIC_URL=https://<its public name>
// node --import tsx examples/build-events/src/notifier.ts`, with server.ts running. build-events
// POSTs only to a globally reachable address, so on one machine give it a tunnel's name.
const server = Layer.unwrap(
  Effect.gen(function* () {
    const buildEvents = yield* Config.String("BUILDS_URL").pipe(
      Config.withDefault("http://127.0.0.1:3000")
    );

    // Redacted, so a log or an error printing the configuration never shows the token.
    const token = yield* Config.Redacted("BUILDS_TOKEN");
    const publicUrl = yield* Config.String("PUBLIC_URL");

    // The loopback default serves this machine alone, which a tunnel reaches; HOST=0.0.0.0 lets
    // build-events reach it directly.
    const host = yield* Config.String("HOST").pipe(
      Config.withDefault("127.0.0.1")
    );

    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3001));

    return HttpRouter.serve(notifier({ buildEvents, token, publicUrl })).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
      // The receiver's route is public and reads each body whole: a delivery is at most 256 KiB.
      Layer.provide(
        Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(256))
      ),
      // DEMO ONLY: notices and the watch's cursor live in this process's memory.
      Layer.provide([
        Notices.layerMemory,
        KeyValueStore.layerMemory,
        FetchHttpClient.layer,
      ])
    );
  })
);

Layer.launch(server).pipe(NodeRuntime.runMain());
