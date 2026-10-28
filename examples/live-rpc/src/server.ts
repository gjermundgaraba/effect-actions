import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { MessageStore } from "./chat/store.js";
import { rpc } from "./routes.js";

const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson)
);

const server = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Config.String("HOST").pipe(
      Config.withDefault("127.0.0.1")
    );

    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    return HttpRouter.serve(socket).pipe(
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host,
          port,
          websocket: { maxPayload: 64 * 1024 },
        })
      ),
      Layer.provide(MessageStore.layerMemory),
      Layer.provide(Event.layerMemory)
    );
  })
);

Layer.launch(server).pipe(NodeRuntime.runMain());
