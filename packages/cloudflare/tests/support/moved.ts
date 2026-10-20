import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export const Follow = Rpc.make("follow", { payload: {}, success: Schema.Int, stream: true });

const FollowRpcs = RpcGroup.make(Follow);

const followHandlers = FollowRpcs.toLayer(
  Effect.map(ActionDurableObject.Feed, (feed) =>
    FollowRpcs.of({ follow: (_, request) => feed.subscribe(request, { initial: [10] }) }),
  ),
);

export const pathKey = "tests/moved/path";

export const startupKey = "tests/moved/startup";

const storedPath = Schema.decodeUnknownOption(Schema.Literals(["/a", "/b"]));

export const movedRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* ActionDurableObject.State;
    const stored = yield* Effect.promise(() => state.storage.get(pathKey));

    return RpcServer.layer(FollowRpcs).pipe(
      Layer.provide(followHandlers),
      Layer.provide(
        ActionDurableObject.layerWebSocket({
          path: Option.getOrElse(storedPath(stored), () => "/a"),
        }),
      ),
    );
  }),
);

export const startupPublisher = Layer.effectDiscard(
  Effect.gen(function* () {
    const state = yield* ActionDurableObject.State;
    const feed = yield* ActionDurableObject.Feed;
    const exit = yield* Effect.exit(feed.publish(Follow, 88));

    yield* Effect.promise(() =>
      state.storage.put(startupKey, Exit.isSuccess(exit) ? "published" : Cause.pretty(exit.cause)),
    );
  }),
);
