import { type Cause, Context, Deferred, Effect, Layer, Predicate, Queue, Schema } from "effect";
import { RpcMessage, type RpcSerialization, RpcServer } from "effect/rpc";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { makeRegistries } from "./registry.js";

/**
 * What a call over the stub carries to the object's `effectActionsRpc`: its messages, as values.
 * A class of its own delegating the method takes it as its parameter,
 * `effectActionsRpc(request: ActionDurableObject.StubRequest)`.
 */
export type StubRequest = ReadonlyArray<RpcMessage.FromClientEncoded>;

type Serve = (request: StubRequest) => Effect.Effect<ReadonlyArray<RpcMessage.FromServerEncoded>>;

interface Registry {
  serve: Serve | undefined;
  readonly running: Deferred.Deferred<void>;
}

const registries = makeRegistries<Calls["Service"], Registry>("layerStub", "Calls");

/**
 * The object's dispatcher for the calls a caller makes over its stub: `call` hands one call's
 * messages to the protocol `layerStub` registered, and succeeds with their responses once every
 * request it carries has its exit. `handlers` and `make` provide one per instance, which
 * `layerStub` registers with as the served Layer builds.
 *
 * **Gotchas**
 *
 * - A call through a protocol no rpc server runs on, such as a group's handlers given without `RpcServer.layer(group)`, dies a second after it arrives.
 */
export class Calls extends Context.Service<
  Calls,
  {
    /** Answers one call over the stub: its encoded messages, in, and its responses, out. */
    readonly call: (
      request: StubRequest,
    ) => Effect.Effect<ReadonlyArray<RpcMessage.FromServerEncoded>>;
  }
>()("effect-actions-cloudflare/ActionDurableObject/Calls") {
  /** One dispatcher, with no protocol registered. */
  static readonly layer: Layer.Layer<Calls> = Layer.sync(Calls)(() => {
    const registry: Registry = { serve: undefined, running: Deferred.makeUnsafe() };

    // Why: a server starts in a fiber of its own, forked as the calls build, so a first call may
    // arrive before it runs, and waits; calls serving no server on the protocol, such as a
    // handlers Layer without `RpcServer.layer`, would leave it waiting for good. A server runs
    // within a few scheduler turns of the build, so a second past it means none will, and the
    // caller hears so long before its own timeout.
    const running = Deferred.await(registry.running).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () =>
          Effect.die(
            new Error(
              "No rpc server runs on this object's stub protocol: serve a group over it in make's or handlers' calls, such as RpcServer.layer(group)",
            ),
          ),
      }),
    );

    const calls = Calls.of({
      call: (request) =>
        Effect.suspend(() =>
          registry.serve === undefined
            ? Effect.die(
                new Error(
                  "No stub protocol registered with this object's Calls: serve a group in make's or handlers' calls",
                ),
              )
            : Deferred.isDoneUnsafe(registry.running)
              ? registry.serve(request)
              : Effect.andThen(running, registry.serve(request)),
        ),
    });

    registries.register(calls, registry);

    return calls;
  });
}

/**
 * The codec of the stub's values: each schema's type to its plain form, `Schema.toCodecIso`, which
 * Workers RPC's structured clone carries as it is, a `Date`, bytes, `undefined` and a `Map` among
 * them, where JSON would encode them again. An `Exit`, a `Cause` and an `Option` encode to their
 * tagged objects, a class instance to its fields.
 */
// Why: `toCodecIso` types its codec without the services its schema's transformations still
// require, and `CodecFor` names them, as Effect's own JSON serialization casts `toCodecJson`, so
// a server and a client owe the services their values need to encode and decode.
export const codecFor = Schema.toCodecIso as RpcSerialization.CodecFor;

const encodeDefect = Schema.encodeSync(codecFor(Schema.Defect()));

/**
 * A unary `RpcServer.Protocol` over the object's stub, passing values, modeled on Effect's HTTP
 * protocol: one call is one client, its requests and their responses, then its end.
 */
const makeProtocol = (registry: Registry) =>
  Effect.gen(function* () {
    // Why: one method answers every call over the stub, so a second protocol would leave the
    // first's group unserved, or answer another group's calls.
    if (registry.serve !== undefined) {
      return yield* Effect.die(
        new Error(
          "Two stub protocols in one object's calls: serve every group over one, merged with group.merge(other)",
        ),
      );
    }

    const context = yield* Effect.context<never>();
    const disconnects = yield* Queue.make<number>();

    interface Client {
      readonly responses: Queue.Queue<RpcMessage.FromServerEncoded, Cause.Done>;
      // Why: keyed by each request's id as sent, as Effect's ids `1` and `"1"` are two requests.
      readonly pending: Map<string | number, string>;
    }

    const clients = new Map<number, Client>();
    let nextId = 0;

    // Why: Effect's server sends a defect it takes as fatal, such as a handler's die, to the
    // client as a bare `Defect`, and Effect's client fails every call it holds then, iterating
    // them as it resumes each caller: a caller resuming within that step and calling again is
    // failed by the same defect. One call over the stub is one client, so the defect is the exit
    // of each request it carries without one, sent as that request's.
    const failPending = (client: Client, defect: RpcMessage.ResponseDefectEncoded) => {
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
              }),
            ),
      );
    };

    const protocol = yield* RpcServer.Protocol.make((write) => {
      registry.serve = (request) =>
        Effect.gen(function* () {
          const clientId = nextId++;

          const client: Client = {
            responses: yield* Queue.make<RpcMessage.FromServerEncoded, Cause.Done>(),
            pending: new Map(),
          };

          clients.set(clientId, client);

          // Why: a call ending before its requests do, such as when its runtime interrupts it,
          // disconnects its client, which interrupts them, as Effect's HTTP protocol does.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              clients.delete(clientId);
              Queue.offerUnsafe(disconnects, clientId);
            }),
          );

          // Why: a request that is no array of messages, or a message the server cannot read, is
          // answered with a defect, as Effect's HTTP protocol answers a body, never rejecting the
          // call: what a caller sent is checked by RpcServer, message by message.
          yield* Effect.suspend(() =>
            Effect.forEach(
              request,
              (message) => {
                if (Predicate.isTagged(message, "Request"))
                  client.pending.set(message.id, message.tag);

                return write(clientId, message);
              },
              { discard: true },
            ),
          ).pipe(
            Effect.catchDefect((defect) =>
              failPending(client, RpcMessage.ResponseDefectEncoded(encodeDefect(defect))),
            ),
          );

          yield* write(clientId, RpcMessage.constEof);

          return yield* Queue.collect(client.responses);
        }).pipe(Effect.scoped, Effect.provideContext(context));

      return Effect.succeed({
        disconnects,
        send: (clientId, response) =>
          Effect.suspend(() => {
            const client = clients.get(clientId);

            if (client === undefined) return Effect.void;

            if (Predicate.isTagged(response, "Defect")) return failPending(client, response);

            if (!Predicate.isTagged(response, "Chunk")) {
              if (Predicate.isTagged(response, "Exit")) client.pending.delete(response.requestId);

              return Queue.offer(client.responses, response);
            }

            // Why: one method call answers once, so a stream's chunks have nowhere to go: the
            // call is answered with a defect naming the rpc, and its client ended and
            // disconnected, which interrupts the stream.
            const tag = client.pending.get(response.requestId) ?? "";

            return failPending(
              client,
              RpcMessage.ResponseDefectEncoded(
                encodeDefect(
                  new Error(
                    `The rpc ${tag} streams, and the object's stub is unary: serve streams over layerWebSocket`,
                  ),
                ),
              ),
            ).pipe(
              Effect.andThen(Queue.end(client.responses)),
              Effect.andThen(Queue.offer(disconnects, clientId)),
            );
          }),
        end: (clientId) =>
          Effect.suspend(() => {
            const client = clients.get(clientId);

            return client === undefined ? Effect.void : Queue.end(client.responses);
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

    const served = {
      ...protocol,
      run: (f) => Effect.andThen(Deferred.succeed(registry.running, undefined), protocol.run(f)),
    } satisfies RpcServer.Protocol["Service"];

    return { ...served, [ActionRpc.unaryProtocol]: true };
  });

/**
 * The `RpcServer.Protocol` the object's `calls` serve on, over its stub, registered with the
 * instance's `Calls`: `handlers` and `make` give it to them, and the `calls` option holds its
 * rules.
 */
export const layerStub = (): Layer.Layer<RpcServer.Protocol, never, Calls> =>
  Layer.effect(RpcServer.Protocol)(
    Effect.service(Calls).pipe(Effect.flatMap(registries.of), Effect.flatMap(makeProtocol)),
  );
