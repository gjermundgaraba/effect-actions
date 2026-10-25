import { Layer } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import * as Testing from "../../src/testing/Testing.js";

export const overHttp = <E, R>(rpcs: Layer.Layer<never, E, R>) =>
  RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(
      Testing.layer(
        rpcs.pipe(
          Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
      ),
    ),
  );
