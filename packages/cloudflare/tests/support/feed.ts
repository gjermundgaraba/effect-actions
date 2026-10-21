import {
  Context,
  Deferred,
  Effect,
  Layer,
  Match,
  Ref,
  Schema,
  SchemaTransformation,
  Stream,
} from "effect";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import * as Feed from "@gjermundgaraba/effect-actions/Feed";
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

export const HeaderNames = Rpc.make("headerNames", { success: Schema.Array(Schema.String) });

const SlowlyEncoded = Schema.Int.pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transformEffect({
      decode: Effect.succeed,
      encode: (value) => Effect.as(Effect.sleep("1 millis"), value),
    }),
  ),
);

export const SlowTicks = Rpc.make("slowTicks", { success: SlowlyEncoded, stream: true });

export class Gate extends Context.Service<
  Gate,
  {
    readonly read: Deferred.Deferred<void>;
    readonly released: Deferred.Deferred<void>;
    readonly finalized: Ref.Ref<number>;
    readonly encoding: Deferred.Deferred<void>;
    readonly encoded: Deferred.Deferred<void>;
  }
>()("tests/Gate") {
  static readonly layer = Layer.effect(Gate)(
    Effect.all({
      read: Deferred.make<void>(),
      released: Deferred.make<void>(),
      finalized: Ref.make(0),
      encoding: Deferred.make<void>(),
      encoded: Deferred.make<void>(),
    }),
  );
}

const HeldEncoded = Schema.Int.pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transformEffect({
      decode: Effect.succeed,
      encode: (value) =>
        Effect.flatMap(Effect.service(Gate), ({ encoding, encoded }) =>
          Deferred.succeed(encoding, undefined).pipe(
            Effect.andThen(Deferred.await(encoded)),
            Effect.as(value),
          ),
        ),
    }),
  ),
);

export const HeldTicks = Rpc.make("heldTicks", { success: HeldEncoded, stream: true });

export const FeedRpcs = RpcGroup.make(Ticks, Ping, HeaderNames, SlowTicks, HeldTicks);

export const OtherTicks = Rpc.make("ticks", {
  payload: { initial: Schema.Array(Schema.Int) },
  success: Schema.Int,
  stream: true,
});

const OtherRpcs = RpcGroup.make(OtherTicks);

export const FeedCalls = RpcGroup.make(
  Rpc.make("publish", { payload: { value: Schema.Int, key: Schema.NullOr(Schema.String) } }),
  Rpc.make("announce", { payload: { value: Schema.Int } }),
  Rpc.make("end", { payload: { key: Schema.NullOr(Schema.String) } }),
  Rpc.make("publishWhenRead", { payload: { value: Schema.Int } }),
  Rpc.make("endWhenRead", { payload: { key: Schema.NullOr(Schema.String) } }),
  Rpc.make("endWhenEncoding"),
  Rpc.make("release"),
  Rpc.make("finalized", { success: Schema.Int }),
  Rpc.make("publishSlowly", { payload: { value: Schema.Int } }),
  Rpc.make("wipe"),
);

export class Announcer extends Context.Service<
  Announcer,
  { readonly announce: (value: number) => Effect.Effect<void> }
>()("tests/Announcer") {
  static readonly layer = Layer.effect(Announcer)(
    Effect.map(Effect.service(Feed.Feed), (feed) =>
      Announcer.of({ announce: (value) => feed.publish(Ticks, value) }),
    ),
  );
}

const keyOf = (key: string | null) => key ?? undefined;

const tickHandlers = FeedRpcs.toLayer(
  Effect.gen(function* () {
    const feed = yield* Feed.Feed;
    const gate = yield* Gate;
    const { read, released, finalized } = gate;

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

        return (
          gate === "after" ? Stream.tap(stream, () => Deferred.await(released)) : stream
        ).pipe(Stream.ensuring(Ref.update(finalized, (count) => count + 1)));
      },
      ping: () => Effect.void,
      headerNames: (_, { headers }) => Effect.succeed(Object.keys(headers)),
      slowTicks: (_, request) => feed.subscribe(request, { initial: [5] }),
      heldTicks: (_, request) =>
        feed
          .subscribe(request, { initial: [5] })
          .pipe(
            Stream.provideService(Gate, gate),
            Stream.ensuring(Ref.update(finalized, (count) => count + 1)),
          ),
    });
  }),
);

const otherHandlers = OtherRpcs.toLayer(
  Effect.map(Effect.service(Feed.Feed), (feed) =>
    OtherRpcs.of({ ticks: ({ initial }, request) => feed.subscribe(request, { initial }) }),
  ),
);

export const feedRoutes = Layer.mergeAll(
  RpcServer.layer(FeedRpcs).pipe(
    Layer.provide(tickHandlers),
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
  ),
  RpcServer.layer(FeedRpcs).pipe(
    Layer.provide(tickHandlers),
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/http" })),
    Layer.provide(RpcSerialization.layerNdjson),
  ),
);

export const twoPathRoutes = Layer.merge(
  feedRoutes,
  RpcServer.layer(OtherRpcs).pipe(
    Layer.provide(otherHandlers),
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/other" })),
  ),
);

export const feedCalls = RpcServer.layer(FeedCalls.merge(FeedRpcs)).pipe(
  Layer.provide(tickHandlers),
  Layer.provide(
    FeedCalls.toLayer(
      Effect.gen(function* () {
        const feed = yield* Feed.Feed;
        const state = yield* ActionDurableObject.State;
        const announcer = yield* Announcer;
        const { read, released, finalized, encoding, encoded } = yield* Gate;

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
          endWhenRead: ({ key }) =>
            Effect.andThen(Deferred.await(read), feed.end(Ticks, { key: keyOf(key) })),
          endWhenEncoding: () =>
            Deferred.await(encoding).pipe(
              Effect.andThen(feed.end(HeldTicks)),
              Effect.andThen(Deferred.succeed(encoded, undefined)),
              Effect.asVoid,
            ),
          release: () => Effect.asVoid(Deferred.succeed(released, undefined)),
          finalized: () => Ref.get(finalized),
          publishSlowly: ({ value }) => feed.publish(SlowTicks, value),
          wipe: () =>
            Effect.andThen(
              feed.end(),
              Effect.promise(() => state.storage.deleteAll()),
            ),
        });
      }),
    ),
  ),
);
