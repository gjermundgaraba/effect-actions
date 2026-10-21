import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import * as Feed from "../../src/feed/Feed.js";
import {
  controlHandlers,
  Controls,
  feedContract,
  Gate,
  streamHandlers,
  Streams,
} from "../support/feed-contract.js";

feedContract(
  "Feed.layer",
  Effect.gen(function* () {
    const server = yield* Layer.build(
      Layer.merge(streamHandlers, controlHandlers).pipe(
        Layer.provideMerge(Layer.merge(Feed.layer, Gate.layer)),
      ),
    );

    return yield* Effect.all({
      streams: RpcTest.makeClient(Streams),
      controls: RpcTest.makeClient(Controls),
    }).pipe(Effect.provideContext(server));
  }),
);
