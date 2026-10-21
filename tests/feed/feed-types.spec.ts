import { expectTypeOf } from "@effect/vitest";
import { Context, Effect, type Layer, Schema, SchemaTransformation, type Stream } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import * as Feed from "../../src/feed/Feed.js";

class Offset extends Context.Service<Offset, number>()("types/Offset") {}

const Offsetted = Rpc.make("offsetted", {
  success: Schema.Int.pipe(
    Schema.decodeTo(
      Schema.Int,
      SchemaTransformation.transformEffect({
        decode: Effect.succeed,
        encode: (value) => Effect.map(Effect.service(Offset), (offset) => value + offset),
      }),
    ),
  ),
  stream: true,
});

const Plain = Rpc.make("plain", { success: Schema.String, stream: true });

declare const feed: Feed.Feed["Service"];

declare const subscriber: Feed.Subscriber<typeof Offsetted>;

expectTypeOf(Feed.layer).toEqualTypeOf<Layer.Layer<Feed.Feed>>();

expectTypeOf(feed.publish(Offsetted, 1)).toEqualTypeOf<Effect.Effect<void, never, Offset>>();

expectTypeOf(feed.subscribe(subscriber)).toEqualTypeOf<Stream.Stream<number, never, Offset>>();

expectTypeOf<Feed.ChunkServices<typeof Offsetted>>().toEqualTypeOf<Offset>();

expectTypeOf<Feed.ChunkServices<typeof Plain>>().toEqualTypeOf<never>();

expectTypeOf(feed.end()).toEqualTypeOf<Effect.Effect<void>>();

expectTypeOf(feed.end(Plain, { key: "room" })).toEqualTypeOf<Effect.Effect<void>>();

// @ts-expect-error -- A value published is the rpc's chunk.
void feed.publish(Plain, 1);

// @ts-expect-error -- A key ends the subscribers of one rpc: end() alone ends every rpc's.
void feed.end(undefined, { key: "room" });

const Group = RpcGroup.make(Plain);

expectTypeOf(
  Group.toLayer(
    Effect.succeed(
      Group.of({ plain: (_, request) => feed.subscribe(request, { initial: ["a"] }) }),
    ),
  ),
).toEqualTypeOf<Layer.Layer<Rpc.Handler<"plain">>>();

void Group.of({
  // @ts-expect-error -- A handler's subscriber is typed by its rpc: its initial values are the rpc's chunk.
  plain: (_, request) => feed.subscribe(request, { initial: [1] }),
});
