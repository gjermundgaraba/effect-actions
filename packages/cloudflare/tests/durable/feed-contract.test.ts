import { env } from "cloudflare:test";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { Controls, Streams } from "../../../../tests/support/feed-contract.js";
import { feedContract } from "../../../../tests/support/feed-contract-suite.js";
import { upgradeToRpc } from "../support/socket.js";

let objects = 0;

feedContract(
  "ActionDurableObject.layerFeed",
  Effect.gen(function* () {
    const stub = env.CONTRACTED.getByName(`contract-${objects++}`);
    const socket = yield* upgradeToRpc(stub);

    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.effect(Socket.Socket)(Socket.fromWebSocket(Effect.succeed(socket)))),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );

    return {
      streams: yield* RpcClient.make(Streams).pipe(Effect.provideContext(protocol)),
      controls: yield* RpcClient.make(Controls).pipe(
        Effect.provide(ActionDurableObject.layerStubClient(() => stub)),
      ),
    };
  }),
);
