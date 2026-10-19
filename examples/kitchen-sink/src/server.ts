import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ByteSize, Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { memory } from "./memory.js";
import { adminRoutes, builders, publicRoutes, rpc } from "./routes.js";

// Entrypoint: `node --import tsx examples/kitchen-sink/src/server.ts`.
// The entrypoint of the server: two listeners over one set of builders and services.

// The web app's rpcs over a WebSocket at `/rpc`: Node's HTTP server answers the upgrade. The
// protocol is this entrypoint's choice, as the ports are. `rpc` leaves it open, so a test
// serves the same layer over Effect's HTTP protocol.
const socket = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);

const server = Layer.unwrap(
  Effect.gen(function* () {
    // The loopback default serves this machine alone; HOST=0.0.0.0 lets others reach it.
    const host = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
    const publicPort = yield* Config.Port("PORT").pipe(Config.withDefault(3000));
    const adminPort = yield* Config.Port("ADMIN_PORT").pipe(Config.withDefault(3001));

    const limit = ByteSize.mebibytes(1);

    const listen = (port: number) =>
      NodeHttpServer.layer(createServer, {
        host,
        port,
        // A message on the WebSocket of `/rpc` is no request body, so the limit below does not
        // bound it: Node's WebSocket server reads one of up to 100 MiB whole unless told
        // otherwise. A larger one closes the socket (1009).
        websocket: { maxPayload: Number(limit) },
      });

    return Layer.mergeAll(
      // Two audiences, two listeners. Each `HttpRouter.serve` builds its routes in a layer
      // graph of its own, with a router of its own: the public port can only ever reach the
      // members' routes, and nothing built inside one is shared with the other. The socket
      // is merged into the public port's graph, so it is a route of that router: the request
      // policy, global to the router, refuses a foreign Origin's upgrade as it does a request,
      // and the rpcs spend the quota the routes spend, built once.
      HttpRouter.serve(Layer.merge(publicRoutes, socket)).pipe(Layer.provide(listen(publicPort))),
      HttpRouter.serve(adminRoutes).pipe(Layer.provide(listen(adminPort))),
    ).pipe(
      // Request bodies have no size limit unless the host sets one. This covers every HTTP
      // route of both ports, the MCP endpoint included.
      Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, limit)),
      // So what both ports share is provided outside both, once: the builders, then the
      // services the builders, the verifiers and the quota are built from. A workspace an
      // operator suspends on one port is thereby refused on the other.
      Layer.provide(builders),
      Layer.provide(memory),
    );
  }),
);

// NodeRuntime handles signals: the scoped layers stop both listeners and release the services.
Layer.launch(server).pipe(NodeRuntime.runMain);
