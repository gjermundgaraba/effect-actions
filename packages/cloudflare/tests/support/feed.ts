import { Effect, Layer, Schema } from "effect";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export const Ticks = Rpc.make("ticks", {
  payload: { key: Schema.NullOr(Schema.String), initial: Schema.Array(Schema.Int) },
  success: Schema.Int,
  stream: true,
});

export const Ping = Rpc.make("ping");

export const FeedRpcs = RpcGroup.make(Ticks, Ping);

export const FeedCalls = RpcGroup.make(
  Rpc.make("publish", { payload: { value: Schema.Int, key: Schema.NullOr(Schema.String) } }),
  Rpc.make("end", { payload: { key: Schema.NullOr(Schema.String) } }),
);

const keyOf = (key: string | null) => key ?? undefined;

export const feedRoutes = RpcServer.layer(FeedRpcs).pipe(
  Layer.provide(
    FeedRpcs.toLayer(
      Effect.gen(function* () {
        const feed = yield* ActionDurableObject.Feed;

        return FeedRpcs.of({
          ticks: ({ key, initial }, request) =>
            feed.subscribe(request, { initial, key: keyOf(key) }),
          ping: () => Effect.void,
        });
      }),
    ),
  ),
  Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
);

export const feedCalls = RpcServer.layer(FeedCalls).pipe(
  Layer.provide(
    FeedCalls.toLayer(
      Effect.gen(function* () {
        const feed = yield* ActionDurableObject.Feed;

        return FeedCalls.of({
          publish: ({ value, key }) => feed.publish(Ticks, value, { key: keyOf(key) }),
          end: ({ key }) => feed.end(Ticks, { key: keyOf(key) }),
        });
      }),
    ),
  ),
);
