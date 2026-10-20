import { Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect";
import { Rpc, type RpcMessage, RpcSchema, RpcSerialization } from "effect/rpc";
import { recordKey, records, socketOfRecord, socketTag, Subscription } from "./feed.js";
import { State } from "./state.js";

/**
 * What `subscribe` reads of a stream rpc's call: its handler's second argument, as Effect's
 * server gives it, `(payload, request) => feed.subscribe(request)`.
 */
export interface Subscriber<R extends Rpc.Any> {
  readonly client: Rpc.ServerClient;
  readonly requestId: RpcMessage.RequestId;
  readonly rpc: R;
}

/** `Feed`'s `subscribe` options. */
export interface SubscribeOptions<A, E = never, R = never> {
  /**
   * What the subscriber is sent first, as one chunk, read after its record is kept: an Effect
   * of the values, such as a store's read of what came after the client's last, or the values.
   * Nothing is sent first without it, or when it is empty.
   */
  readonly initial?: ReadonlyArray<A> | Effect.Effect<ReadonlyArray<A>, E, R> | undefined;
  /**
   * What the subscriber follows of the rpc's feed, such as a topic: only a `publish` naming it,
   * or one naming none, reaches the subscriber.
   */
  readonly key?: string | undefined;
}

/** `Feed`'s `publish` options. */
export interface PublishOptions {
  /** The subscribers it reaches, those given this key; every subscriber of the rpc without it. */
  readonly key?: string | undefined;
}

/** `Feed`'s `end` options. */
export interface EndOptions {
  /** The subscribers it ends, those given this key; every subscriber of the rpc without it. */
  readonly key?: string | undefined;
}

const json = RpcSerialization.json;

type Encode = (values: ReadonlyArray<unknown>) => Effect.Effect<unknown>;

const encoders = new WeakMap<Rpc.Any, Encode>();

// Why: a chunk is sent as Effect's server sends one, which encodes it with the rpc's stream
// schemas through the protocol's JSON codec, so the client decodes it as the server's own.
const chunkEncoderOf = (rpc: Rpc.Any): Encode => {
  const cached = encoders.get(rpc);

  if (cached !== undefined) return cached;

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native rpc boundary: every rpc a group holds is a native `Rpc`, carrying its schemas.
  const success = (rpc as Rpc.AnyWithProps).successSchema;

  if (!RpcSchema.isStreamSchema(success)) {
    throw new Error(
      `ActionDurableObject.Feed publishes only to an rpc that streams, and ${rpc._tag} does not: make it with stream: true`,
    );
  }

  const encode = Schema.encodeUnknownEffect(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased rpc schemas: the feed provides a chunk's schema no service, so one needing a service to encode dies as it encodes.
    json.codecFor(Schema.NonEmptyArray(success.success)) as Schema.Codec<unknown, unknown>,
  );

  const encoder: Encode = (values) => Effect.orDie(encode(values));

  encoders.set(rpc, encoder);

  return encoder;
};

const exitOf = (rpc: Rpc.Any) =>
  Schema.encodeUnknownSync(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased rpc schemas: a successful stream's exit encodes no value, so it needs no service.
    json.codecFor(Rpc.exitSchema(rpc)) as Schema.Codec<unknown, unknown>,
  )(Exit.void);

const recordOf = Schema.decodeUnknownOption(Subscription);

const RequestId = Schema.Union([Schema.String, Schema.Number]);

// Why: what the client reads is these frames, as Effect's server encodes its responses: a chunk
// of encoded values, and an exit encoded with the rpc's exit schema.
const ChunkFrame = Schema.TaggedStruct("Chunk", { requestId: RequestId, values: Schema.Unknown });

const ExitFrame = Schema.TaggedStruct("Exit", { requestId: RequestId, exit: Schema.Unknown });

/**
 * The object's subscribers to the rpcs that stream over `layerWebSocket`, kept in its storage, so
 * a value published reaches them after the object hibernated, was evicted or rebuilt, as long as
 * their sockets stay open: `subscribe` makes a stream rpc's call one, `publish` sends each of the
 * rpc's subscribers a value, and `end` completes their streams. `Feed.layer` makes one per
 * instance; `handlers` and `make` provide it to the calls, the routes, the alarm and `run`, so
 * any of them publishes.
 *
 * **Gotchas**
 *
 * - A subscriber whose `initial` fails ends with its failure, its record dropped.
 * - At least once across the join, never lost: a value published while a subscriber's `initial` is read may reach it twice, in `initial` and as published, so give values an id the client drops repeats by.
 * - A value published while `initial` is read may arrive before it: the stream is in order from the first value published after `initial` is sent.
 * - Each chunk's ack wakes a hibernating object: Effect's client acknowledges every chunk it is sent, which the object's server ignores for a call it no longer runs.
 * - Effect's socket client fails every stream it runs when its socket drops: a page resubscribes, with `Stream.retry`, from the last value it holds, which `initial` sends on.
 * - Only a call over `layerWebSocket` subscribes: over another protocol it has no socket, and the first `publish` drops its record.
 * - A record is dropped when the client interrupts its stream or the socket closes, and when a `publish` finds its socket gone; a socket closing while the object is evicted leaves its records until then.
 * - `storage.deleteAll()` drops every subscriber's record with the application's own data, silently: those subscribers get nothing more, so `end` them before wiping the object's storage.
 * - `publish` reads every subscriber's record from storage: one per open stream of every rpc.
 * - A value that does not encode as the rpc's chunk is a defect; an rpc that does not stream is refused, naming it.
 *
 * Guide: `docs/ActionDurableObject-feed.md` in this package.
 */
export class Feed extends Context.Service<
  Feed,
  {
    /**
     * The stream a stream rpc's handler returns to make its call a subscriber: its record kept
     * first, then `initial` sent as one chunk, then every value published to it, never ending.
     */
    readonly subscribe: <R extends Rpc.Any, E = never, RR = never>(
      request: Subscriber<R>,
      options?: SubscribeOptions<Rpc.SuccessChunk<R>, E, RR>,
    ) => Stream.Stream<Rpc.SuccessChunk<R>, E, RR>;
    /** Sends `value` to each subscriber of `rpc` whose socket is open, as one chunk. */
    readonly publish: <R extends Rpc.Any>(
      rpc: R,
      value: Rpc.SuccessChunk<R>,
      options?: PublishOptions,
    ) => Effect.Effect<void>;
    /** Completes the stream of each subscriber of `rpc`, and drops their records. */
    readonly end: (rpc: Rpc.Any, options?: EndOptions) => Effect.Effect<void>;
  }
>()("effect-actions-cloudflare/ActionDurableObject/Feed") {
  /** The feed of the instance whose `State` it is given. */
  static readonly layer: Layer.Layer<Feed, never, State> = Layer.effect(Feed)(
    Effect.map(Effect.service(State), (state) => {
      const parser = json.makeUnsafe();
      const storage = state.storage;

      const drop = (key: string) => Effect.promise(() => storage.delete(key));

      // Why: each record names its socket by its id, so a socket the object accepted before it
      // hibernated is found by its tag, which the runtime keeps; one that is gone, or rejects
      // the send as it closes, drops the record.
      const sendTo = (
        tag: string,
        key: string | undefined,
        frame: (requestId: string | number) => typeof ChunkFrame.Type | typeof ExitFrame.Type,
        after: (storageKey: string) => Effect.Effect<void>,
      ) =>
        Effect.flatMap(records(storage), (all) =>
          Effect.forEach(
            all,
            ([storageKey, stored]) => {
              const socket = socketOfRecord(storageKey);
              const record = recordOf(stored);

              if (socket === undefined || Option.isNone(record)) return drop(storageKey);

              if (record.value.tag !== tag || (key !== undefined && record.value.key !== key)) {
                return Effect.void;
              }

              const sockets = state.getWebSockets(socketTag(socket));

              if (sockets.length === 0) return drop(storageKey);

              const encoded = parser.encode(frame(record.value.requestId));

              try {
                for (const socket of sockets) if (encoded !== undefined) socket.send(encoded);
              } catch {
                return drop(storageKey);
              }

              return after(storageKey);
            },
            { discard: true },
          ),
        );

      return Feed.of({
        subscribe: (request, options) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const key = recordKey(request.client.id, String(request.requestId));

              yield* Effect.promise(() =>
                storage.put(
                  key,
                  Subscription.make({
                    tag: request.rpc._tag,
                    key: options?.key,
                    requestId: request.requestId,
                  }),
                ),
              );

              const initial = options?.initial ?? [];

              // Why: the record is kept before `initial` is read, so nothing published meanwhile
              // is lost; a call whose `initial` fails has ended, and a record left behind would
              // send its client chunks for it.
              const values = Effect.isEffect(initial)
                ? yield* Effect.onError(initial, () => drop(key))
                : initial;

              return Stream.concat(Stream.fromArray(values), Stream.never);
            }),
          ),
        publish: (rpc, value, options) =>
          Effect.flatMap(
            Effect.suspend(() => chunkEncoderOf(rpc)([value])),
            (values) =>
              sendTo(
                rpc._tag,
                options?.key,
                (requestId) => ChunkFrame.make({ requestId, values }),
                () => Effect.void,
              ),
          ),
        end: (rpc, options) =>
          Effect.suspend(() => {
            const exit = exitOf(rpc);

            return sendTo(
              rpc._tag,
              options?.key,
              (requestId) => ExitFrame.make({ requestId, exit }),
              drop,
            );
          }),
      });
    }),
  );
}
