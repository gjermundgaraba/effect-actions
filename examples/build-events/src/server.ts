import { createServer } from "node:http";

import {
  NodeDns,
  NodeFileSystem,
  NodeHttpServer,
  NodePath,
  NodeRuntime,
} from "@effect/platform-node";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { ByteSize, Config, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";

import { BuildStore } from "./builds/store.js";
import { Approvers } from "./deploys/approvers.js";
import { routes } from "./routes.js";

const server = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Config.String("HOST").pipe(
      Config.withDefault("127.0.0.1")
    );

    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    const webhooks = yield* Config.String("WEBHOOKS_DIR").pipe(
      Config.withDefault(".build-events/webhooks")
    );

    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
      Layer.provide(
        Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1))
      ),
      Layer.provide([BuildStore.layerMemory, Approvers.layerMemory]),
      Layer.provide(Event.layerMemory),
      Layer.provide(
        KeyValueStore.layerFileSystem(webhooks).pipe(
          Layer.provide([NodeFileSystem.layer, NodePath.layer])
        )
      ),
      Layer.provide([FetchHttpClient.layer, NodeDns.layer])
    );
  })
);

Layer.launch(server).pipe(NodeRuntime.runMain());
