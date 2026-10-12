import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { MessageStore } from "./chat/store.js";
import { rpc } from "./routes.js";

// Entrypoint: `node --import tsx examples/live-rpc/src/server.ts`.
// The composition root of the server. It chooses the protocol, the store and the port, and
// starts Node's HTTP server. It provides no caller and no room: those arrive with each message.

// The rpcs over a WebSocket at `/rpc`, the router's one route: Node's HTTP server answers the
// upgrade. `ActionRpc.layer` serves a protocol speaking JSON, and the client must speak the
// same one.
const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);

const server = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    return HttpRouter.serve(socket).pipe(
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          // This machine alone. A server others reach reads its host from config:
          // `Config.String("HOST").pipe(Config.withDefault("127.0.0.1"))`.
          host: "127.0.0.1",
          port,
          // A message on a WebSocket is no request body, so `HttpServerRequest.MaxBodySize`
          // does not bound it: Node's WebSocket server reads one of up to 100 MiB whole unless
          // told otherwise. A chat message is short, and a larger one closes the socket (1009).
          websocket: { maxPayload: 64 * 1024 },
        }),
      ),
      Layer.provide(MessageStore.layerMemory),
    );
  }),
);

Layer.launch(server).pipe(NodeRuntime.runMain);
