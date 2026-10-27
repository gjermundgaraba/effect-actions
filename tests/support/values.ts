import { Effect, Layer, Queue, Schema } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import type { RpcMessage, RpcSerialization } from "effect/rpc";

import * as ActionRpc from "../../src/rpc/ActionRpc.js";

const valuesCodecFor: RpcSerialization.CodecFor = Schema.toCodecIso;

const unconnected = () => Effect.void;

export interface ValuesProtocolOptions {
  readonly acknowledges?: boolean;
  readonly keeper?: ActionRpc.SubscriptionKeeper;
  readonly sent?: RpcMessage.FromServerEncoded[];
}

export const inMemoryValuesProtocolTo = <E, R>(
  server: Layer.Layer<never, E, R>,
  { acknowledges = false, keeper, sent }: ValuesProtocolOptions = {}
): Layer.Layer<RpcClient.Protocol, E, Exclude<R, RpcServer.Protocol>> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const disconnects = yield* Queue.make<number>();
      const clientIds = new Set<number>();

      let toServer: (
        clientId: number,
        message: RpcMessage.FromClientEncoded
      ) => Effect.Effect<void> = unconnected;

      let toClient: (
        clientId: number,
        message: RpcMessage.FromServerEncoded
      ) => Effect.Effect<void> = unconnected;

      const serverProtocol = yield* RpcServer.Protocol.make((write) => {
        toServer = write;

        return Effect.succeed({
          disconnects,
          send: (clientId, response) =>
            Effect.suspend(() => {
              sent?.push(response);

              return toClient(clientId, structuredClone(response));
            }),
          end: () => Effect.void,
          clientIds: Effect.succeed(clientIds),
          initialMessage: Effect.succeedNone,
          supportsAck: acknowledges,
          supportsTransferables: false,
          supportsSpanPropagation: false,
          supportsNotifications: false,
          codecFor: valuesCodecFor,
        });
      });

      const clientProtocol = yield* RpcClient.Protocol.make((write) => {
        toClient = write;

        return Effect.succeed({
          send: (clientId, message) =>
            Effect.suspend(() => {
              clientIds.add(clientId);

              return toServer(clientId, structuredClone(message));
            }),
          supportsAck: acknowledges,
          supportsTransferables: false,
          codecFor: valuesCodecFor,
        });
      });

      const keeping = {
        ...serverProtocol,
        [ActionRpc.subscriptionKeeper]: keeper,
      };

      return Layer.merge(
        Layer.succeed(RpcClient.Protocol, clientProtocol),
        server.pipe(
          Layer.provide(
            Layer.succeed(
              RpcServer.Protocol,
              keeper === undefined ? serverProtocol : keeping
            )
          )
        )
      );
    })
  );
