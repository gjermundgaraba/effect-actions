import { Layer } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";

import * as Testing from "../../src/testing/Testing.js";

/** `rpcs` served over Effect's HTTP protocol at `/rpc`, as routes. */
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
