import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  References,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { Rpc, type RpcMessage, RpcSchema, RpcSerialization } from "effect/rpc";
import { RequestId, sendFrame } from "./frames.js";
import { makeRegistries } from "./registry.js";
import { State } from "./state.js";

const recordPrefix = "effect-actions/feed/";

const ofSocket = (socket: number) => `${recordPrefix}${socket}/`;

/**
 * The storage key of the subscription `requestId` on the socket `socket`. A request id is a
 * number or a string, which the server and its client tell apart, so the key keeps which.
 */
export const recordKey = (socket: number, requestId: string | number) =>
  `${ofSocket(socket)}${Predicate.isNumber(requestId) ? "n" : "s"}${requestId}`;

/**
 * A subscription, as storage keeps it: its rpc's tag, the key it was given, and its request's id
 * as the client sent it, which the client finds its call by.
 */
const Subscription = Schema.Struct({
  tag: Schema.String,
  key: Schema.UndefinedOr(Schema.String),
  requestId: RequestId,
});

const recordOf = Schema.decodeUnknownOption(Subscription);

const socketOfRecord = (storageKey: string) => {
  const socket = Number(storageKey.slice(recordPrefix.length).split("/")[0]);

  return Number.isInteger(socket) ? socket : undefined;
};

/** Drops the record of `requestId` on `socket`, or, without it, all of the socket's. */
export const forget = (
  storage: DurableObjectStorage,
  socket: number,
  requestId?: string | number,
) =>
  Effect.promise(async () => {
    if (requestId !== undefined) {
      await storage.delete(recordKey(socket, requestId));

      return;
    }

    const keys = [...(await storage.list({ prefix: ofSocket(socket) })).keys()];

    // Why: the runtime deletes at most 128 keys in one call.
    for (let start = 0; start < keys.length; start += 128) {
      await storage.delete(keys.slice(start, start + 128));
    }
  });

/**
 * The socket a call came in on, its id, which `layerWebSocket` provides around each message it
 * hands its server, so the handler's fiber inherits it, and none for a call over any other
 * protocol.
 */
export const CurrentSocket = Context.Reference<Option.Option<number>>(
  "effect-actions-cloudflare/ActionDurableObject/CurrentSocket",
  { defaultValue: Option.none },
);

const registries = makeRegistries<Feed["Service"], Set<string>>("layerWebSocket", "Feed");

/** Registers `path`, a `layerWebSocket`'s, as one whose sockets `feed` serves. */
export const servePath = (feed: Feed["Service"], path: string) =>
  Effect.map(registries.of(feed), (paths) => void paths.add(path));

/**
 * What `subscribe` reads of a stream rpc's call: its handler's second argument, as Effect's
 * server gives it, `(payload, request) => feed.subscribe(request)`.
 */
export type Subscriber<R extends Rpc.Any> = Parameters<Rpc.ToHandlerFn<R>>[1];

/** What the values of a stream rpc `R` need to encode, as its schema declares it. */
type ChunkServices<R extends Rpc.Any> =
  Rpc.SuccessSchema<R> extends RpcSchema.Stream<infer A, infer _E> ? A["EncodingServices"] : never;

/** `Feed`'s `subscribe` options. */
export interface SubscribeOptions<A, E = never, R = never> {
  /**
   * What the subscriber is sent first, as one chunk, to its socket as soon as it is read, its
   * record kept before: an Effect of the values, such as a store's read of what came after the
   * client's last, or the values. Nothing is sent first without it, or when it is empty.
   *
   * **Gotchas**
   *
   * - It runs with Effect's scheduler yields off, the fibers it forks included, so its values are sent in the step that reads them: a long synchronous read holds the object's other fibers until it is sent.
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

type Values = RpcMessage.ResponseChunkEncoded["values"];

type Encode = (values: ReadonlyArray<unknown>) => Effect.Effect<Values>;

// Why: a codec is made once per rpc, as Effect's server makes one per rpc, since making it walks
// the rpc's schemas, which a feed publishing on every change would otherwise walk each time.
const encoders = new WeakMap<Rpc.Any, Encode>();

// Why: a chunk is sent as Effect's server sends one, which encodes it with the rpc's stream
// schemas through the protocol's JSON codec, so the client decodes it as the server's own.
const encoderOf = (rpc: Rpc.Any): Encode => {
  const cached = encoders.get(rpc);

  if (cached !== undefined) return cached;

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native rpc boundary: every rpc a group holds is a native `Rpc`, carrying its schemas.
  const success = (rpc as Rpc.AnyWithProps).successSchema;

  const encode = Schema.encodeUnknownEffect(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased rpc schemas: JSON's codec of a non-empty array encodes one; the services its values need to encode are the caller's, which `publish` and `subscribe` owe as `ChunkServices`.
    json.codecFor(
      Schema.NonEmptyArray(RpcSchema.isStreamSchema(success) ? success.success : success),
    ) as Schema.Codec<unknown, Values>,
  );

  const encoder: Encode = (values) => Effect.orDie(encode(values));

  encoders.set(rpc, encoder);

  return encoder;
};

const chunkOf = (requestId: string | number, values: Values): RpcMessage.ResponseChunkEncoded =>
  // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect's wire frame, which `RpcMessage` types and makes no constructor for: its type checks every field.
  ({ _tag: "Chunk", requestId, values });

const exitOf = (rpc: Rpc.Any) =>
  Schema.encodeUnknownSync(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased rpc schemas: a successful stream's exit encodes no value, so it needs no service, to the exit Effect's client reads.
    json.codecFor(Rpc.exitSchema(rpc)) as Schema.Codec<
      unknown,
      RpcMessage.ExitEncoded<unknown, unknown>
    >,
  )(Exit.void);

/**
 * The object's subscribers to the rpcs that stream over `layerWebSocket`, kept in its storage, so
 * a value published reaches them after the object hibernated, was evicted or rebuilt, as long as
 * their sockets stay open: a push channel addressed by each call's request id, not a stream
 * pipeline. `subscribe` makes a stream rpc's call one, `publish` sends each of the rpc's
 * subscribers a value, and `end` completes their streams. `Feed.layer` makes one per instance;
 * `handlers` and `make` provide it to the services, the calls, the routes, the alarm and `run`,
 * so any of them publishes.
 *
 * **Gotchas**
 *
 * - The stream `subscribe` returns is a handle on the call, not its values, which go to the socket as `publish` sends them: an operator applied to it, such as `Stream.map`, sees none, so transform a value before publishing it, or give subscribers a `key`.
 * - At least once across the join, never lost: a value published while `initial` is read may arrive before it and again in it, never after it out of order, since `initial` goes to the socket as it is read; give values an id the client drops repeats by. A schema whose encoding is asynchronous yields between the read and the send, and a value published then arrives before the snapshot.
 * - A subscriber whose `initial` fails ends with its failure, its record dropped; a value published while it was read reaches the client first, as one chunk its stream emits before it fails.
 * - `end` completes a live subscriber's stream through Effect's server, which runs its finalizers and answers its client, and answers a subscriber whose call hibernation dropped itself; one ended while its `initial` is read or encoded is sent nothing, the read interrupted.
 * - Only a call over `layerWebSocket` subscribes: one over the stub or another protocol dies at once, `subscribes a call over layerWebSocket alone`.
 * - It serves the sockets of one `layerWebSocket` path, since a record names its rpc by tag alone and a group holds one rpc per tag, a later one replacing an earlier: an object whose routes serve two dies at each `subscribe`, `publish` and `end`, naming them, so serve every rpc that streams on one path.
 * - Access is checked once, as the call subscribes: a subscriber is published to until its socket closes, whatever becomes of its credential or membership, so end a member's subscribers, subscribed under a key of their own, with `end(rpc, { key })`, or close their socket from a handler, found with `State`'s `getWebSockets`.
 * - The feed waits for no acknowledgement: a page that stops acknowledging still receives every value, and each chunk Effect's client acknowledges wakes a hibernating object, whose server ignores the ack.
 * - Effect's socket client fails every stream it runs when its socket drops, and a stream may end with a defect, from the server or a chunk the client cannot decode: a page observing only failures misses that end and shows a subscription that is gone, so it reads the stream's `Exit`, `Effect.exit` around its run, then subscribes again from the last value it holds, which `initial` sends on.
 * - A record is dropped when the client interrupts its stream or the socket closes, and when a `publish` finds its socket gone or refusing the send; a socket closing while the object is evicted leaves its records until then.
 * - `storage.deleteAll()` drops every subscriber's record with the application's own data, silently: those subscribers get nothing more, so `end` them before wiping the object's storage.
 * - `publish` encodes its value, then reads every subscriber's record from storage, one per open stream of every rpc, one `publish` or `end` sending at a time: a subscriber receives what is published after its `initial` was sent in the order the publishes finished encoding, the order of the calls for a schema that encodes synchronously; between a publish and `initial`, the join's rule above holds.
 * - A value that does not encode as the rpc's chunk is a defect.
 *
 * Guide: `docs/ActionDurableObject-feed.md` in this package.
 */
export class Feed extends Context.Service<
  Feed,
  {
    /**
     * The stream a stream rpc's handler returns to make its call a subscriber: its record kept
     * first, then `initial` sent to the socket as one chunk as it is read, then every value
     * published to it, until `end` completes it.
     */
    readonly subscribe: <R extends Rpc.Any, E = never, RR = never>(
      request: Subscriber<R>,
      options?: SubscribeOptions<Rpc.SuccessChunk<R>, E, RR>,
    ) => Stream.Stream<Rpc.SuccessChunk<R>, E, RR | ChunkServices<R>>;
    /** Sends `value` to each subscriber of `rpc` whose socket is open, as one chunk. */
    readonly publish: <R extends Rpc.Any>(
      rpc: R,
      value: Rpc.SuccessChunk<R>,
      options?: PublishOptions,
    ) => Effect.Effect<void, never, ChunkServices<R>>;
    /** Completes the stream of each subscriber of `rpc`, and drops their records. */
    readonly end: (rpc: Rpc.Any, options?: EndOptions) => Effect.Effect<void>;
  }
>()("effect-actions-cloudflare/ActionDurableObject/Feed") {
  /** The feed of the instance whose `State` it is given. */
  static readonly layer: Layer.Layer<Feed, never, State> = Layer.effect(Feed)(
    Effect.gen(function* () {
      const state = yield* State;
      const storage = state.storage;
      const lock = yield* Semaphore.make(1);

      // Why: a subscription this instance runs ends through its own stream, so Effect's server
      // answers it and runs its finalizers: `end` completes it by its latch, and answers only a
      // subscriber whose call is gone, as after hibernation, itself.
      const latches = new Map<string, Deferred.Deferred<void>>();

      const drop = (key: string) => Effect.promise(() => storage.delete(key));

      // Why: a record names its rpc by tag alone, the one identity of an rpc that survives
      // hibernation, and a tag is one rpc only on one path, whose group holds one rpc per tag:
      // so the feed serves one path, or none, and refuses before it sends anything.
      const paths = new Set<string>();

      const oneServed = Effect.suspend(() =>
        paths.size > 1
          ? Effect.die(
              new Error(
                `ActionDurableObject.Feed serves the sockets of one layerWebSocket path, and the object serves ${[...paths].join(" and ")}, whose rpcs it cannot tell apart: serve every rpc that streams on one path`,
              ),
            )
          : Effect.void,
      );

      const subscribersOf = (rpc: Rpc.Any, key: string | undefined) =>
        Effect.gen(function* () {
          yield* oneServed;

          const all = yield* Effect.promise(() => storage.list({ prefix: recordPrefix }));

          const matching: Array<{
            readonly storageKey: string;
            readonly socket: number;
            readonly requestId: string | number;
          }> = [];

          for (const [storageKey, stored] of all) {
            const socket = socketOfRecord(storageKey);
            const record = recordOf(stored);

            if (socket === undefined || Option.isNone(record)) {
              yield* drop(storageKey);
            } else if (
              record.value.tag === rpc._tag &&
              (key === undefined || record.value.key === key)
            ) {
              matching.push({ storageKey, socket, requestId: record.value.requestId });
            }
          }

          return matching;
        });

      const sendInitial = <R extends Rpc.Any>(
        request: Subscriber<R>,
        socket: number,
        key: string,
        ended: Deferred.Deferred<void>,
        values: ReadonlyArray<Rpc.SuccessChunk<R>>,
      ) =>
        Effect.gen(function* () {
          const chunk = values.length === 0 ? undefined : yield* encoderOf(request.rpc)(values);

          // Why: an `end` interrupts this read once its latch's waiter runs, and an
          // asynchronous encoding resuming before that would send its chunk after the end: a
          // client whose access ended would still receive it.
          if (Deferred.isDoneUnsafe(ended)) return Stream.empty;

          if (
            chunk !== undefined &&
            !(yield* sendFrame(state, socket, chunkOf(request.requestId, chunk)))
          ) {
            yield* drop(key);

            return Stream.empty;
          }

          return Stream.fromEffectDrain(Deferred.await(ended));
        });

      const feed = Feed.of({
        subscribe: (request, options) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const found = yield* CurrentSocket;

              if (Option.isNone(found)) {
                return yield* Effect.die(
                  new Error(
                    `ActionDurableObject.Feed subscribes a call over layerWebSocket alone, and ${request.rpc._tag} was called over another protocol: serve it with layerWebSocket`,
                  ),
                );
              }

              yield* oneServed;

              const socket = found.value;
              const key = recordKey(socket, request.requestId);
              const ended = yield* Deferred.make<void>();

              latches.set(key, ended);

              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  if (latches.get(key) === ended) latches.delete(key);
                }),
              );

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
              const read = Effect.isEffect(initial) ? initial : Effect.succeed(initial);

              // Why: the record is kept before `initial` is read, so nothing published meanwhile
              // is lost; a call whose `initial` fails has ended, and a record left behind would
              // send its client chunks for it. The values go to the socket as they are read, as a
              // publish sends, rather than through the server, which writes them on a later
              // step: a publish landing in between would reach the client first, and a feed of
              // snapshots would show the older one last. For the same reason the read and the send
              // run with no scheduler yield, which would let a publish in between them. An `end`
              // meanwhile interrupts them, so a read that never returns holds no call open.
              return yield* Effect.onError(
                Effect.raceFirst(
                  Effect.flatMap(read, (values) =>
                    sendInitial(request, socket, key, ended, values),
                  ),
                  Effect.as(Deferred.await(ended), Stream.empty),
                ).pipe(Effect.provideService(References.PreventSchedulerYield, true)),
                () => drop(key),
              );
            }),
          ),
        publish: (rpc, value, options) =>
          Effect.flatMap(encoderOf(rpc)([value]), (values) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                for (const { storageKey, socket, requestId } of yield* subscribersOf(
                  rpc,
                  options?.key,
                )) {
                  if (!(yield* sendFrame(state, socket, chunkOf(requestId, values)))) {
                    yield* drop(storageKey);
                  }
                }
              }),
            ),
          ),
        end: (rpc, options) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              for (const { storageKey, socket, requestId } of yield* subscribersOf(
                rpc,
                options?.key,
              )) {
                const live = latches.get(storageKey);

                yield* live === undefined
                  ? sendFrame(
                      state,
                      socket,
                      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect's wire frame, which `RpcMessage` types and makes no constructor for: its type checks every field.
                      { _tag: "Exit", requestId, exit: exitOf(rpc) },
                    )
                  : Deferred.succeed(live, undefined);

                yield* drop(storageKey);
              }
            }),
          ),
      });

      registries.register(feed, paths);

      return feed;
    }),
  );
}
