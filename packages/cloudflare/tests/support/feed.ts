import { Context, Effect, Layer, Schema } from "effect";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export class NoInitial extends Schema.TaggedError<NoInitial>()("NoInitial", {}) {}

export const Ticks = Rpc.make("ticks", {
  payload: {
    key: Schema.NullOr(Schema.String),
    initial: Schema.Array(Schema.Int),
    failInitial: Schema.optional(Schema.Boolean),
  },
  success: Schema.Int,
  error: NoInitial,
  stream: true,
});

export const Ping = Rpc.make("ping");

export const FeedRpcs = RpcGroup.make(Ticks, Ping);

export const FeedCalls = RpcGroup.make(
  Rpc.make("publish", { payload: { value: Schema.Int, key: Schema.NullOr(Schema.String) } }),
  Rpc.make("announce", { payload: { value: Schema.Int } }),
  Rpc.make("end", { payload: { key: Schema.NullOr(Schema.String) } }),
);

export class Announcer extends Context.Service<
  Announcer,
  { readonly announce: (value: number) => Effect.Effect<void> }
>()("tests/Announcer") {
  static readonly layer = Layer.effect(Announcer)(
    Effect.map(Effect.service(ActionDurableObject.Feed), (feed) =>
      Announcer.of({ announce: (value) => feed.publish(Ticks, value) }),
    ),
  );
}

const keyOf = (key: string | null) => key ?? undefined;

export const feedRoutes = RpcServer.layer(FeedRpcs).pipe(
  Layer.provide(
    FeedRpcs.toLayer(
      Effect.gen(function* () {
        const feed = yield* ActionDurableObject.Feed;

        return FeedRpcs.of({
          ticks: ({ key, initial, failInitial }, request) =>
            feed.subscribe(request, {
              initial:
                failInitial === true ? Effect.fail(new NoInitial()) : Effect.succeed(initial),
              key: keyOf(key),
            }),
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
        const announcer = yield* Announcer;

        return FeedCalls.of({
          announce: ({ value }) => announcer.announce(value),
          publish: ({ value, key }) => feed.publish(Ticks, value, { key: keyOf(key) }),
          end: ({ key }) => feed.end(Ticks, { key: keyOf(key) }),
        });
      }),
    ),
  ),
);
