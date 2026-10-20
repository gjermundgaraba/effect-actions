import { Context, Deferred, Effect, Layer, Match, Schema, Stream } from "effect";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export class NoInitial extends Schema.TaggedError<NoInitial>()("NoInitial", {}) {}

export const Ticks = Rpc.make("ticks", {
  payload: {
    key: Schema.NullOr(Schema.String),
    initial: Schema.Array(Schema.Int),
    failInitial: Schema.optional(Schema.Boolean),
    gate: Schema.optional(Schema.Literals(["during", "after", "long"])),
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
  Rpc.make("publishWhenRead", { payload: { value: Schema.Int } }),
);

export class Gate extends Context.Service<
  Gate,
  { readonly read: Deferred.Deferred<void>; readonly released: Deferred.Deferred<void> }
>()("tests/Gate") {
  static readonly layer = Layer.effect(Gate)(
    Effect.all({ read: Deferred.make<void>(), released: Deferred.make<void>() }),
  );
}

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
        const { read, released } = yield* Gate;

        return FeedRpcs.of({
          ticks: ({ key, initial, failInitial, gate }, request) => {
            const values =
              failInitial === true ? Effect.fail(new NoInitial()) : Effect.succeed(initial);

            const isRead = Deferred.succeed(read, undefined);

            const stream = feed.subscribe(request, {
              initial: Match.value(gate).pipe(
                Match.when("during", () =>
                  isRead.pipe(Effect.andThen(Deferred.await(released)), Effect.andThen(values)),
                ),
                Match.when("after", () => Effect.tap(values, () => isRead)),
                Match.when("long", () =>
                  Effect.tap(values, () =>
                    Effect.andThen(
                      isRead,
                      Effect.forEach(Array.from({ length: 20_000 }), () => Effect.void, {
                        discard: true,
                      }),
                    ),
                  ),
                ),
                Match.orElse(() => values),
              ),
              key: keyOf(key),
            });

            return gate === "after" ? Stream.tap(stream, () => Deferred.await(released)) : stream;
          },
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
        const { read, released } = yield* Gate;

        return FeedCalls.of({
          announce: ({ value }) => announcer.announce(value),
          publish: ({ value, key }) => feed.publish(Ticks, value, { key: keyOf(key) }),
          end: ({ key }) => feed.end(Ticks, { key: keyOf(key) }),
          publishWhenRead: ({ value }) =>
            Deferred.await(read).pipe(
              Effect.andThen(feed.publish(Ticks, value)),
              Effect.andThen(Deferred.succeed(released, undefined)),
              Effect.asVoid,
            ),
        });
      }),
    ),
  ),
);
