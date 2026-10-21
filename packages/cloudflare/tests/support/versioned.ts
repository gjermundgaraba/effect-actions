import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export const expectedProtocol = "3";

export const statusKey = "tests/versioned/status";

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

    return yield* ActionDurableObject.refuseUpgrade(4000, "unsupported protocol");
  }),
);

const recordStatus = HttpRouter.middleware(
  Effect.map(
    ActionDurableObject.State,
    (state) => (httpEffect) =>
      Effect.tap(httpEffect, (response) =>
        Effect.promise(() => state.storage.put(statusKey, response.status)),
      ),
  ),
);

export const versionedRoutes = RpcServer.layer(VersionedRpcs).pipe(
  Layer.provide(VersionedRpcs.toLayer({ protocol: () => Effect.succeed(expectedProtocol) })),
  Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
  Layer.provide(refuseOtherProtocols.layer),
  Layer.provide(recordStatus.layer),
);
