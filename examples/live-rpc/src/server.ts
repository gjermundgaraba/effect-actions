import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import * as Feed from "@gjermundgaraba/effect-actions/Feed";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { MessageStore } from "./chat/store.js";
import { rpc } from "./routes.js";

// Entrypoint: `node --import tsx examples/live-rpc/src/server.ts`.
// It chooses the protocol, the store and the port, and starts Node's HTTP server. It provides
// no caller and no room: those arrive with each message.

// The rpcs over a WebSocket at `/rpc`, the router's one route: Node's HTTP server answers the
// upgrade. JSON, because a page's client speaks it: browser.ts gives its socket the same
// serialization.
const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);

const server = Layer.unwrap(
  Effect.gen(function* () {
    // The loopback default serves this machine alone; HOST=0.0.0.0 lets others reach it.
    const host = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));

    return HttpRouter.serve(socket).pipe(
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host,
          port,
          // A message on a WebSocket is no request body, so `HttpServerRequest.MaxBodySize`
          // does not bound it: Node's WebSocket server reads one of up to 100 MiB whole unless
          // told otherwise. A chat message is short, and a larger one closes the socket (1009).
          websocket: { maxPayload: 64 * 1024 },
        }),
      ),
      // DEMO ONLY: messages live in this process's memory; a deployment provides a store that
      // lasts. The feed holds the pages following a room, which this process's sockets serve,
      // so it lives here too, one for the whole server.
      Layer.provide([MessageStore.layerMemory, Feed.layer]),
    );
  }),
);

Layer.launch(server).pipe(NodeRuntime.runMain);
