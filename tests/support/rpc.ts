import { Effect, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";

import * as Testing from "../../src/testing/Testing.js";

export const rpcRoutes = <E, R>(
  rpcs: Layer.Layer<never, E, R>,
  serialization: Layer.Layer<RpcSerialization.RpcSerialization> = RpcSerialization.layerNdjson
) =>
  rpcs.pipe(
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(serialization)
  );

export const overHttp = <E, R>(
  rpcs: Layer.Layer<never, E, R>,
  serialization: Layer.Layer<RpcSerialization.RpcSerialization> = RpcSerialization.layerNdjson
) =>
  RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(serialization),
    Layer.provide(Testing.layer(rpcRoutes(rpcs, serialization)))
  );

export const unaryOf = <A, E, R>(
  answer: Effect.Effect<A, E, R> | Stream.Stream<A, E, R> | undefined,
  rpc: string
): Effect.Effect<A, E, R> =>
  answer !== undefined && Effect.isEffect(answer)
    ? answer
    : Effect.die(new Error(`No unary rpc ${rpc}`));

export const streamOf = <A, E, R>(
  answer: Effect.Effect<A, E, R> | Stream.Stream<A, E, R> | undefined,
  rpc: string
): Stream.Stream<A, E, R> =>
  answer !== undefined && Stream.isStream(answer)
    ? answer
    : Stream.die(new Error(`No stream rpc ${rpc}`));
