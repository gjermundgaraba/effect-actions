import { createServer } from "node:http";

import { NodeDns, NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Config, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { memory } from "./memory.js";
import { adminRoutes, builders, publicRoutes, rpc } from "./routes.js";

const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson)
);

const server = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Config.String("HOST").pipe(
      Config.withDefault("127.0.0.1")
    );

    const publicPort = yield* Config.Port("PORT").pipe(
      Config.withDefault(3000)
    );

    const adminPort = yield* Config.Port("ADMIN_PORT").pipe(
      Config.withDefault(3001)
    );

    const limit = ByteSize.mebibytes(1);

    const listen = (port: number) =>
      NodeHttpServer.layer(createServer, {
        host,
        port,
        websocket: { maxPayload: Number(limit) },
      });

    return Layer.mergeAll(
      HttpRouter.serve(Layer.merge(publicRoutes, socket)).pipe(
        Layer.provide(listen(publicPort))
      ),
      HttpRouter.serve(adminRoutes).pipe(Layer.provide(listen(adminPort)))
    ).pipe(
      Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, limit)),
      Layer.provide(builders),
      Layer.provide(memory),
      Layer.provide([FetchHttpClient.layer, NodeDns.layer])
    );
  })
);

Layer.launch(server).pipe(NodeRuntime.runMain());
