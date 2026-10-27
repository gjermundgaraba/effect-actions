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

// Entrypoint: `node --import tsx examples/build-events/src/server.ts`.
// It chooses the stores, reads the configuration and starts Node's HTTP server.
const server = Layer.unwrap(
  Effect.gen(function* () {
    // The loopback default serves this machine alone; HOST=0.0.0.0 lets others reach it.
    const host = yield* Config.String("HOST").pipe(
      Config.withDefault("127.0.0.1")
    );

    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    const webhooks = yield* Config.String("WEBHOOKS_DIR").pipe(
      Config.withDefault(".build-events/webhooks")
    );

    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host, port })),
      // Request bodies have no size limit unless the host sets one. This covers every route
      // that reads its body whole, the MCP endpoint and the webhook subscribe routes included.
      Layer.provide(
        Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(1))
      ),
      // DEMO ONLY: builds and approvers live in this process's memory; a deployment provides
      // stores that last.
      Layer.provide([BuildStore.layerMemory, Approvers.layerMemory]),
      // The events this process announces: a notify after a build finishes, and each deploy
      // request published. One for the whole server, which holds every subscriber's connection.
      Layer.provide(Event.layerMemory),
      // Webhook subscriptions are kept as files under WEBHOOKS_DIR, so a restart goes on
      // delivering them; after one, the memory store above sends each a gap first. The files
      // hold each subscriber's secret: give the directory to this server alone, and each server
      // process its own, since the layer is its store's one writer.
      Layer.provide(
        KeyValueStore.layerFileSystem(webhooks).pipe(
          Layer.provide([NodeFileSystem.layer, NodePath.layer])
        )
      ),
      // Webhook delivery POSTs with fetch, and resolves each callback with the system's resolver.
      Layer.provide([FetchHttpClient.layer, NodeDns.layer])
    );
  })
);

Layer.launch(server).pipe(NodeRuntime.runMain());
