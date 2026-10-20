import { type Cause, Context, Deferred, Effect, Layer, Predicate, Queue, Schema } from "effect";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";

type Serve = (request: string) => Effect.Effect<string>;

interface Registry {
  serve: Serve | undefined;
  readonly running: Deferred.Deferred<void>;
}

// Why: registering is no concept of the dispatcher's own: only `layerStub` registers, so the
// registry is reached through the dispatcher here rather than a method consumers would see.
const registries = new WeakMap<Calls["Service"], Registry>();

/**
 * The object's dispatcher for the calls a caller makes over its stub: `call` hands one call's
 * encoded request to the protocol `layerStub` registered, and succeeds with the encoded responses
 * once every request it carries has its exit, or dies when no protocol registered, or when no
 * rpc server runs on the protocol a second after the call. `Calls.layer` makes one per instance, which `layerStub`
 * registers with as the served Layer builds: dispatch once it is built.
 */
export class Calls extends Context.Service<
  Calls,
  {
    /** Answers one call over the stub: its encoded request, in, and its encoded responses, out. */
    readonly call: (request: string) => Effect.Effect<string>;
  }
>()("effect-actions-cloudflare/ActionDurableObject/Calls") {
  /** One dispatcher, with no protocol registered. */
  static readonly layer: Layer.Layer<Calls> = Layer.sync(Calls)(() => {
    const registry: Registry = { serve: undefined, running: Deferred.makeUnsafe() };

    // Why: a server starts in a fiber of its own, forked as the calls build, so a first call may
    // arrive before it runs, and waits; calls serving no server on the protocol, such as a
    // handlers Layer without `RpcServer.layer`, would leave it waiting for good.
    const running = Deferred.await(registry.running).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () =>
          Effect.die(
            new Error(
              "No rpc server runs on this object's ActionDurableObject.layerStub: serve a group over it, such as RpcServer.layer(group)",
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
                  "No ActionDurableObject.layerStub protocol registered with this object's Calls: serve a group over it, such as make's calls option",
                ),
              )
            : Effect.andThen(running, registry.serve(request)),
        ),
    });

    registries.set(calls, registry);

    return calls;
  });
}

const json = RpcSerialization.json;

const encodeDefect = Schema.encodeSync(json.codecFor(Schema.Defect()));

const unary = (tag: string) =>
  new Error(
    `The rpc ${tag} streams, and ActionDurableObject.layerStub is unary: serve streams over layerWebSocket`,
  );

/**
 * A unary `RpcServer.Protocol` over the object's stub, speaking JSON, modeled on Effect's HTTP
 * protocol: one call is one client, its requests and their responses, then its end.
 */
const makeProtocol = (registry: Registry) =>
  Effect.gen(function* () {
    // Why: one method answers every call over the stub, so a second protocol would leave the
    // first's group unserved, or answer another group's calls.
    if (registry.serve !== undefined) {
      return yield* Effect.die(
        new Error(
          "Two ActionDurableObject.layerStub protocols of one object: serve every group over one, merged with group.merge(other)",
        ),
      );
    }

    const context = yield* Effect.context<never>();
    const disconnects = yield* Queue.make<number>();

    interface Client {
      readonly responses: Queue.Queue<RpcMessage.FromServerEncoded, Cause.Done>;
      readonly tags: Map<string, string>;
    }

    const clients = new Map<number, Client>();
    let nextId = 0;

    const protocol = yield* RpcServer.Protocol.make((write) => {
      registry.serve = (request) =>
        Effect.gen(function* () {
          const clientId = nextId++;

          const client: Client = {
            responses: yield* Queue.make<RpcMessage.FromServerEncoded, Cause.Done>(),
            tags: new Map(),
          };

          const parser = json.makeUnsafe();

          clients.set(clientId, client);

          // Why: a call ending before its requests do, such as when its runtime interrupts it,
          // disconnects its client, which interrupts them, as Effect's HTTP protocol does.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              clients.delete(clientId);
              Queue.offerUnsafe(disconnects, clientId);
            }),
          );

          // Why: a request that does not parse, or a message the server cannot read, is answered
          // with a defect, as Effect's HTTP protocol answers a body, never rejecting the call.
          yield* Effect.suspend(() =>
            Effect.forEach(
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- What a caller sent: RpcServer checks each message's tag, id and payload, and a message it cannot read fails as a defect, answered as one.
              parser.decode(request) as ReadonlyArray<RpcMessage.FromClientEncoded>,
              (message) => {
                if (Predicate.isTagged(message, "Request"))
                  client.tags.set(String(message.id), message.tag);

                return write(clientId, message);
              },
              { discard: true },
            ),
          ).pipe(
            Effect.catchDefect((defect) =>
              Queue.offer(client.responses, RpcMessage.ResponseDefectEncoded(encodeDefect(defect))),
            ),
          );

          yield* write(clientId, RpcMessage.constEof);

          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The JSON parser encodes to a string.
          return parser.encode(yield* Queue.collect(client.responses)) as string;
        }).pipe(Effect.scoped, Effect.provideContext(context));

      return Effect.succeed({
        disconnects,
        send: (clientId, response) =>
          Effect.suspend(() => {
            const client = clients.get(clientId);

            if (client === undefined) return Effect.void;

            if (!Predicate.isTagged(response, "Chunk"))
              return Queue.offer(client.responses, response);

            // Why: one method call answers once, so a stream's chunks have nowhere to go: the
            // call is answered with a defect naming the rpc, and its client ended and
            // disconnected, which interrupts the stream.
            const tag = client.tags.get(String(response.requestId)) ?? "";

            return Queue.offer(
              client.responses,
              RpcMessage.ResponseDefectEncoded(encodeDefect(unary(tag))),
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
        codecFor: json.codecFor,
      });
    });

    return {
      ...protocol,
      run: (f) => Effect.andThen(Deferred.succeed(registry.running, undefined), protocol.run(f)),
    } satisfies RpcServer.Protocol["Service"];
  });

/**
 * The `RpcServer.Protocol` `RpcServer.layer` and `ActionRpc.layer` serve on, over the object's
 * stub: a caller's call of the object's `effectActionsRpc` method is one call, its requests
 * and their responses, speaking JSON, the stub client's. It registers with the instance's
 * `Calls`, which hands it every call. Unary: a call answers once every request it carries has
 * its exit, so an rpc that streams is answered with a defect at its first chunk. Nothing
 * authenticates a call: a stub is reachable only through a binding, and a caller forwarding a
 * principal sends it as a header, read by `RpcMiddleware`, or in the payload. Each object serves
 * one: a second registering with one `Calls` fails to build. `handlers` and `make` provide it to
 * their `calls`.
 *
 * Guide: `docs/ActionDurableObject-stub.md` in this package.
 */
export const layerStub = (): Layer.Layer<RpcServer.Protocol, never, Calls> =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const registry = registries.get(yield* Calls);

      if (registry === undefined) {
        return yield* Effect.die(
          new Error(
            "ActionDurableObject.layerStub registers only with a Calls that Calls.layer built",
          ),
        );
      }

      return yield* makeProtocol(registry);
    }),
  );
