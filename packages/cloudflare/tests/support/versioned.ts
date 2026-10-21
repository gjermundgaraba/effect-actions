import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export const expectedProtocol = "3";

export const VersionedRpcs = RpcGroup.make(Rpc.make("protocol", { success: Schema.String }));

const refuseOtherProtocols = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { protocol } = yield* HttpServerRequest.ParsedSearchParams;

    if (
      request.headers["upgrade"]?.toLowerCase() !== "websocket" ||
      protocol === expectedProtocol
    ) {
      return yield* httpEffect;
    }

    const { 0: client, 1: server } = new WebSocketPair();

    server.accept();
    server.close(4000, "unsupported protocol");

    return HttpServerResponse.raw(new Response(null, { status: 101, webSocket: client }));
  }),
);

export const versionedRoutes = RpcServer.layer(VersionedRpcs).pipe(
  Layer.provide(VersionedRpcs.toLayer({ protocol: () => Effect.succeed(expectedProtocol) })),
  Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
  Layer.provide(refuseOtherProtocols.layer),
);
