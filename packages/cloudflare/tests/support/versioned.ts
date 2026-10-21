import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export const expectedProtocol = "3";

export const statusKey = "tests/versioned/status";

export const VersionedRpcs = RpcGroup.make(Rpc.make("protocol", { success: Schema.String }));

export const allowedOrigin = "https://pages.example";

const refuseForeignOrigins = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (
      request.headers["upgrade"]?.toLowerCase() !== "websocket" ||
      request.headers["origin"] === allowedOrigin
    ) {
      return yield* httpEffect;
    }

    return yield* ActionDurableObject.refuseUpgrade(4003, "foreign origin");
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

export const givenReason = "Reload: protocol 3 is served here";

const versioned = (options: ActionDurableObject.LayerWebSocketOptions) =>
  RpcServer.layer(VersionedRpcs).pipe(
    Layer.provide(VersionedRpcs.toLayer({ protocol: () => Effect.succeed(expectedProtocol) })),
    Layer.provide(ActionDurableObject.layerWebSocket(options)),
  );

export const versionedRoutes = Layer.merge(
  versioned({ path: "/rpc", protocol: { version: expectedProtocol, code: 4000 } }),
  versioned({
    path: "/reasoned",
    protocol: { version: expectedProtocol, code: 4001, reason: givenReason },
  }),
).pipe(Layer.provide(refuseForeignOrigins.layer), Layer.provide(recordStatus.layer));
