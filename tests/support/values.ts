import { Effect, Layer, Queue, Schema } from "effect";
import { RpcClient, type RpcMessage, type RpcSerialization, RpcServer } from "effect/rpc";

const valuesCodecFor = Schema.toCodecIso as RpcSerialization.CodecFor;

export interface ValuesProtocolOptions {
  readonly acknowledges?: boolean;
  readonly sent?: Array<RpcMessage.FromServerEncoded>;
}

export const inMemoryValuesProtocolTo = <E, R>(
  server: Layer.Layer<never, E, R>,
  { acknowledges = false, sent }: ValuesProtocolOptions = {},
): Layer.Layer<RpcClient.Protocol, E, Exclude<R, RpcServer.Protocol>> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const disconnects = yield* Queue.make<number>();
      const clientIds = new Set<number>();

      let toServer: (
        clientId: number,
        message: RpcMessage.FromClientEncoded,
      ) => Effect.Effect<void> = () => Effect.void;

      let toClient: (
        clientId: number,
        message: RpcMessage.FromServerEncoded,
      ) => Effect.Effect<void> = () => Effect.void;

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
          clientIds: Effect.sync(() => clientIds),
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

      return Layer.merge(
        Layer.succeed(RpcClient.Protocol, clientProtocol),
        server.pipe(Layer.provide(Layer.succeed(RpcServer.Protocol, serverProtocol))),
      );
    }),
  );
