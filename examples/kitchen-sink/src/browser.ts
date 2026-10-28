import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { Rpc } from "./Rpc.js";

export const board = Effect.gen(function* () {
  const tracker = yield* ActionRpc.client(Rpc);

  const me = yield* tracker.whoAmI();
  const { issues } = yield* tracker.listIssues({ status: "open", limit: 50 });

  return { me, issues };
});

export const protocol = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide([
      RpcSerialization.layerJson,
      Socket.layerWebSocketConstructorGlobal,
    ])
  );

export const open = async (url: string) =>
  await Effect.runPromise(
    board.pipe(Effect.scoped, Effect.provide(protocol(url)))
  );
