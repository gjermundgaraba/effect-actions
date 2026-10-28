import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Effect, Predicate, Queue, Schema } from "effect";
import type { Cause } from "effect";
import { RpcMessage, RpcServer } from "effect/rpc";
import type { RpcSerialization } from "effect/rpc";

/**
 * What a call over the stub carries to the object's `effectActionsRpc`: its messages, as values.
 * A class of its own delegating the method takes it as its parameter,
 * `effectActionsRpc(request: ActionDurableObject.StubRequest)`.
 */
export type StubRequest = readonly RpcMessage.FromClientEncoded[];

export const codecFor = Schema.toCodecIso as RpcSerialization.CodecFor;

const encodeDefect = Schema.encodeSync(codecFor(Schema.Defect()));

export const makeStubProtocol = Effect.gen(function* () {
  const context = yield* Effect.context();
  let running = false;
  const disconnects = yield* Queue.make<number>();

  interface Client {
    readonly responses: Queue.Queue<RpcMessage.FromServerEncoded, Cause.Done>;
    readonly pending: Map<string | number, string>;
  }

  const clients = new Map<number, Client>();
  let nextId = 0;

  const failPending = (
    client: Client,
    defect: RpcMessage.ResponseDefectEncoded
  ) => {
    const requests = [...client.pending.keys()];

    client.pending.clear();

    return Queue.offerAll(
      client.responses,
      requests.length === 0
        ? [defect]
        : requests.map((id) =>
            RpcMessage.ResponseExitDieEncoded({
              requestId: RpcMessage.RequestId(id),
              encodedDefect: defect.defect,
            })
          )
    );
  };

  let serve!: (
    request: StubRequest
  ) => Effect.Effect<readonly RpcMessage.FromServerEncoded[]>;

  const protocol = yield* RpcServer.Protocol.make((write) => {
    serve = (request) =>
      Effect.gen(function* () {
        const clientId = nextId;

        nextId += 1;

        const client: Client = {
          responses: yield* Queue.make<
            RpcMessage.FromServerEncoded,
            Cause.Done
          >(),
          pending: new Map(),
        };

        clients.set(clientId, client);

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            clients.delete(clientId);
            Queue.offerUnsafe(disconnects, clientId);
          })
        );

        yield* Effect.suspend(() =>
          Effect.forEach(
            request,
            (message) => {
              if (Predicate.isTagged(message, "Request")) {
                client.pending.set(message.id, message.tag);
              }

              return write(clientId, message);
            },
            { discard: true }
          )
        ).pipe(
          Effect.catchDefect((defect) =>
            failPending(
              client,
              RpcMessage.ResponseDefectEncoded(encodeDefect(defect))
            )
          )
        );

        yield* write(clientId, RpcMessage.constEof);

        return yield* Queue.collect(client.responses);
      }).pipe(Effect.scoped, Effect.provideContext(context));

    return Effect.succeed({
      disconnects,
      send: (clientId, response) =>
        Effect.suspend(() => {
          const client = clients.get(clientId);

          if (client === undefined) {
            return Effect.void;
          }

          if (Predicate.isTagged(response, "Defect")) {
            return failPending(client, response);
          }

          if (!Predicate.isTagged(response, "Chunk")) {
            if (Predicate.isTagged(response, "Exit")) {
              client.pending.delete(response.requestId);
            }

            return Queue.offer(client.responses, response);
          }

          const tag = client.pending.get(response.requestId) ?? "";

          return failPending(
            client,
            RpcMessage.ResponseDefectEncoded(
              encodeDefect(
                new Error(
                  `The rpc ${tag} streams, and the object's stub is unary: serve streams over layerWebSocket`
                )
              )
            )
          ).pipe(
            Effect.andThen(Queue.end(client.responses)),
            Effect.andThen(Queue.offer(disconnects, clientId))
          );
        }),
      end: (clientId) =>
        Effect.suspend(() => {
          const client = clients.get(clientId);

          return client === undefined
            ? Effect.void
            : Queue.end(client.responses);
        }),
      clientIds: Effect.sync(() => new Set(clients.keys())),
      initialMessage: Effect.succeedNone,
      supportsAck: false,
      supportsTransferables: false,
      supportsSpanPropagation: true,
      supportsNotifications: false,
      codecFor,
    });
  });

  return {
    protocol: {
      ...protocol,
      run: (f) =>
        Effect.suspend(() => {
          running = true;

          return protocol.run(f);
        }),
      [ActionRpc.unaryProtocol]: true,
    } satisfies RpcServer.Protocol["Service"] & {
      readonly [ActionRpc.unaryProtocol]: true;
    },
    serve,
    served: Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.suspend(() =>
          running
            ? Effect.void
            : Effect.die(
                new Error(
                  "No rpc server runs on this object's stub protocol: serve a group over it in make's or handlers' calls, such as RpcServer.layer(group)"
                )
              )
        )
      )
    ),
  };
});
