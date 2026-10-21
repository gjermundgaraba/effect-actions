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
import { type Rpc, type RpcMessage, RpcSchema, RpcSerialization } from "effect/rpc";
import { type EndOptions, Feed, type Subscriber } from "@gjermundgaraba/effect-actions/Feed";
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

const registries = makeRegistries<Feed["Service"], Set<string>>(
  "layerWebSocket",
  "Feed",
  "layerFeed",
);

/** Registers `path`, a `layerWebSocket`'s, as one whose sockets `feed` serves. */
export const servePath = (feed: Feed["Service"], path: string) =>
  Effect.map(registries.of(feed), (paths) => void paths.add(path));

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

const schemasOf = (rpc: Rpc.Any) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native rpc boundary: every rpc a group holds is a native `Rpc`, carrying its schemas.
  const { payloadSchema, successSchema, errorSchema, defectSchema } = rpc as Rpc.AnyWithProps;

  return [payloadSchema, successSchema, errorSchema, defectSchema];
};

// Why: the core's `Feed.layer` judges a definition alike, by the four schemas every copy a group
// makes of an rpc keeps, through `middleware`, `annotate` or `prefix`: a feed of either kind
// takes a group's copy for the rpc itself, and refuses another group's rpc of its tag.
const sameDefinition = (one: Rpc.Any, other: Rpc.Any) => {
  const theirs = schemasOf(other);

  return schemasOf(one).every((schema, index) => schema === theirs[index]);
};

const chunkOf = (requestId: string | number, values: Values): RpcMessage.ResponseChunkEncoded =>
  // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect's wire frame, which `RpcMessage` types and makes no constructor for: its type checks every field.
  ({ _tag: "Chunk", requestId, values });

// Why: a stream's exit schema has `Schema.Void` for its success, whatever the rpc, so a
// completed stream's exit encodes alike for every rpc, and `end()` answers a subscriber whose
// rpc it was not given.
const completed = Schema.encodeSync(
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON's codec types its encoding as any JSON: an exit's is the exit Effect's client reads.
  json.codecFor(Schema.Exit(Schema.Void, Schema.Never, Schema.Defect())) as Schema.Codec<
    Exit.Exit<void>,
    RpcMessage.ExitEncoded<unknown, unknown>
  >,
)(Exit.void);

/**
 * The `Feed` of a Durable Object, keeping its subscribers in the object's storage: a value
 * published reaches the subscribers of the rpcs that stream over `layerWebSocket` after the
 * object hibernated, was evicted or rebuilt, as long as their sockets stay open, sent to each
 * socket as Effect's server would send it, addressed by the call's request id: a push channel,
 * not a stream pipeline. `handlers` and `make` provide one per instance to the services, the
 * calls, the routes, the alarm and `run`, so any of them publishes; it requires `State`. The
 * rules every feed keeps are on the core's `Feed`; what this one adds:
 *
 * **Gotchas**
 *
 * - A value published while `initial` is read may arrive before it and again in it, and with a schema that encodes asynchronously, one published between the read and the send arrives before it and not in it; after `initial`, values arrive in the order their publishes finished encoding, the order of the calls for a schema that encodes synchronously.
 * - `initial` is read with Effect's scheduler yields off, the fibers it forks included, so its values are sent in the step that reads them: a long synchronous read holds the object's other fibers until it is sent.
 * - A subscriber whose `initial` fails is sent a value published while it was read first, as one chunk its stream emits before it fails.
 * - `end` answers a subscriber whose call hibernation dropped itself, with its exit; one ended while its `initial` is encoded is sent nothing, as one ended while it is read.
 * - Only a call over `layerWebSocket` subscribes: one over the stub or another protocol dies at once, `subscribes a call over layerWebSocket alone`.
 * - It serves the sockets of one `layerWebSocket` path, since a record names its rpc by tag alone and a group holds one rpc per tag, a later one replacing an earlier: an object whose routes serve two dies at each `subscribe` and `publish`, naming them, so serve every rpc that streams on one path; an `end` there still answers the records it finds, left from before.
 * - A second definition of a served tag, such as another group's rpc published from a service two objects share, dies at the `subscribe`, `publish` or `end` that brings it while this instance runs a subscriber of the first, as the core's `Feed.layer` refuses it; a subscriber whose call hibernation dropped keeps no definition to judge against, so until its page subscribes again another group's rpc of its tag reaches it, encoded by that rpc's schemas.
 * - It serves no path until the routes register theirs, after the services are built: a `subscribe` or `publish` before, such as a service's as it is built, dies, `none is registered yet`, so publish from a handler, the alarm or `run`; an `end` before, such as a `wipe` as the services build, answers the records the instance before left on their sockets.
 * - A socket another path accepted, still open from an instance that served that path before an eviction, is sent no published value, and its records are dropped as a closed socket's; an `end` finding them sends it their exits.
 * - The feed waits for no acknowledgement: a page that stops acknowledging still receives every value, and each chunk Effect's client acknowledges wakes a hibernating object, whose server ignores the ack.
 * - A record is dropped when the client interrupts its stream or the socket closes, and when a `publish` finds its socket gone or refusing the send; a socket closing while the object is evicted leaves its records until then.
 * - Its records live in the object's storage, beside the application's data: wipe that storage with `wipe`, never `storage.deleteAll()` alone, which cuts every subscriber off.
 * - `end()` completes every subscriber this instance runs, even one whose record was still being written as it listed storage, besides every record it finds.
 * - `publish` reads every subscriber's record from storage, one per open stream of every rpc, and one `publish` or `end` sends at a time, after the publish encoded its value.
 * - A value that does not encode as the rpc's chunk is a defect.
 *
 * Guide: `docs/ActionDurableObject-feed.md` in this package.
 */
export const layerFeed: Layer.Layer<Feed, never, State> = Layer.effect(Feed)(
  Effect.gen(function* () {
    const state = yield* State;
    const storage = state.storage;
    const lock = yield* Semaphore.make(1);

    // Why: a subscription this instance runs ends through its own stream, so Effect's server
    // answers it and runs its finalizers: `end` completes it by its latch, and answers only a
    // subscriber whose call is gone, as after hibernation, itself. Its rpc is kept beside, the
    // definition a `publish` or `end` of its tag must be.
    const latches = new Map<
      string,
      { readonly ended: Deferred.Deferred<void>; readonly rpc: Rpc.Any }
    >();

    // Why: a record names its rpc by tag alone, so another group's rpc of that tag, published from
    // a service the two objects share, would reach this path's subscribers, encoded by its own
    // schemas; a subscriber whose call hibernation dropped keeps no rpc to judge against.
    const oneDefinition = (rpc: Rpc.Any) =>
      Effect.suspend(() => {
        const second = [...latches.values()].some(
          (live) => live.rpc._tag === rpc._tag && !sameDefinition(live.rpc, rpc),
        );

        return second
          ? Effect.die(
              new Error(
                `ActionDurableObject.Feed serves one definition of each rpc tag, and a second definition of ${rpc._tag} reached it, as from two groups each defining one: give each rpc its own tag, or each group its own feed`,
              ),
            )
          : Effect.void;
      });

    const drop = (key: string) => Effect.promise(() => storage.delete(key));

    // Why: a record names its rpc by tag alone, the one identity of an rpc that survives
    // hibernation, and a tag is one rpc only on one path, whose group holds one rpc per tag:
    // so the feed serves the one path its routes registered, refusing before then, as the
    // services build, and publishes only to the sockets that path accepted, though a socket an
    // instance serving another path accepted stays open across an eviction.
    const paths = new Set<string>();

    const served = Effect.suspend(() => {
      const [path, ...others] = paths;

      if (path === undefined) {
        return Effect.die(
          new Error(
            "ActionDurableObject.Feed serves the sockets of the layerWebSocket path the routes register, and none is registered yet, as while the services build: publish from a handler, the alarm or run, once the routes are built",
          ),
        );
      }

      return others.length === 0
        ? Effect.succeed(path)
        : Effect.die(
            new Error(
              `ActionDurableObject.Feed serves the sockets of one layerWebSocket path, and the object serves ${[...paths].join(" and ")}, whose rpcs it cannot tell apart: serve every rpc that streams on one path`,
            ),
          );
    });

    const subscribersOf = (rpc: Rpc.Any | undefined, key: string | undefined) =>
      Effect.gen(function* () {
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
            (rpc === undefined || record.value.tag === rpc._tag) &&
            (key === undefined || record.value.key === key)
          ) {
            matching.push({ storageKey, socket, requestId: record.value.requestId });
          }
        }

        return matching;
      });

    const sendInitial = <R extends Rpc.Any>(
      request: Subscriber<R>,
      path: string,
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
          !(yield* sendFrame(state, socket, chunkOf(request.requestId, chunk), path))
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

            const path = yield* served;

            yield* oneDefinition(request.rpc);

            const socket = found.value;
            const key = recordKey(socket, request.requestId);
            const ended = yield* Deferred.make<void>();

            latches.set(key, { ended, rpc: request.rpc });

            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (latches.get(key)?.ended === ended) latches.delete(key);
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
                  sendInitial(request, path, socket, key, ended, values),
                ),
                Effect.as(Deferred.await(ended), Stream.empty),
              ).pipe(
                Effect.provideService(References.PreventSchedulerYield, true),
                // Why: `end()` completes a latch whose record it did not find, one still being
                // written as it listed storage, and that record would outlive the call.
                Effect.tap(() => Effect.when(drop(key), Deferred.isDone(ended))),
              ),
              () => drop(key),
            );
          }),
        ),
      publish: (rpc, value, options) =>
        Effect.flatMap(encoderOf(rpc)([value]), (values) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const path = yield* served;
              const listed = yield* subscribersOf(rpc, options?.key);

              // Why: judged once the audience is listed, not before encoding, which may suspend
              // while a subscriber of the served definition arrives: every listed record's
              // latch existed when it was listed, as a subscribe keeps its latch before its
              // record.
              yield* oneDefinition(rpc);

              for (const { storageKey, socket, requestId } of listed) {
                if (!(yield* sendFrame(state, socket, chunkOf(requestId, values), path))) {
                  yield* drop(storageKey);
                }
              }
            }),
          ),
        ),
      end: (rpc?: Rpc.Any, options?: EndOptions) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            // Why: no path is read, as no registered path is not no subscriber: while the services
            // build, before the routes register theirs, storage holds the records of the instance
            // before, and a `wipe` then must answer them. A record's exit is its socket's own,
            // whatever path accepted it, so it is sent there.
            const listed = yield* subscribersOf(rpc, options?.key);

            // Why: judged once the audience is listed, as `publish` judges it.
            if (rpc !== undefined) yield* oneDefinition(rpc);

            for (const { storageKey, socket, requestId } of listed) {
              const live = latches.get(storageKey)?.ended;

              yield* live === undefined
                ? sendFrame(
                    state,
                    socket,
                    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect's wire frame, which `RpcMessage` types and makes no constructor for: its type checks every field.
                    { _tag: "Exit", requestId, exit: completed },
                  )
                : Deferred.succeed(live, undefined);

              yield* drop(storageKey);
            }

            // Why: a subscribe whose record was still being written as storage was listed is
            // missed by the records, and would wait on its latch for good: `end()` completes
            // every latch this instance holds, as `wipe` relies on.
            if (rpc === undefined && options?.key === undefined) {
              yield* Effect.forEach(
                latches.values(),
                ({ ended }) => Deferred.succeed(ended, undefined),
                {
                  discard: true,
                },
              );
            }
          }),
        ),
    });

    registries.register(feed, paths);

    return feed;
  }),
);

/**
 * Wipes the object's storage, `storage.deleteAll()`, its feed's subscribers ended first, as one
 * step no other event of the object runs within: `end()` completes every subscriber's stream,
 * those this instance runs and those hibernation dropped, and then every key the object stores
 * is dropped, its SQL included, with the feed's records and the socket-id counter.
 *
 * **Gotchas**
 *
 * - `storage.deleteAll()` alone cuts every subscriber off: its record is gone, so no `publish` or `end` reaches it, and its stream stays open, sent nothing, until its socket closes.
 * - It drops the alarm too, as `deleteAll` does from `compatibility_date` `2026-02-24`, or under the `delete_all_deletes_alarm` flag: set it again after the wipe if the object needs one; before that date, or under `delete_all_preserves_alarm`, the alarm is kept, and `storage.deleteAlarm()` drops it.
 * - It ends the subscribers it finds whatever paths the routes serve, none yet included: a `wipe` as the services build answers the records the instance before left on their sockets.
 * - Its steps run with the caller's context, its services and references, and to their end: an interrupt of the caller waits for a wipe already under the gate to complete, never leaving it half done.
 * - A failure of either step, an `end` that dies or a `deleteAll` that rejects, fails `wipe` with that defect, and the object stays whole, though a callback that rejects inside `blockConcurrencyWhile` resets it: the steps' exit is returned through the gate, then raised.
 * - The runtime resets an object whose `blockConcurrencyWhile` runs past 30 seconds, failing every call in flight, as a `deleteAll` over a large database may: wipe such storage in parts of your own first.
 * - It runs under the runtime's `blockConcurrencyWhile`, so no message, call or fetch reaches the object until the wipe completes.
 * - The gate holds new events, not fibers already running in the instance: a subscribe resuming inside the wipe is ended if its latch exists by then, even one whose record was still being written, and otherwise subscribes after the wipe, so its `initial` must read something the wipe removes for that page to be refused.
 */
export const wipe: Effect.Effect<void, never, State | Feed> = Effect.gen(function* () {
  const state = yield* State;
  const feed = yield* Feed;
  const context = yield* Effect.context<never>();

  // Why: a callback that rejects inside `blockConcurrencyWhile` resets the object, failing every
  // call in flight, so the steps' exit crosses the gate as a value and fails `wipe` outside it.
  const exit = yield* Effect.promise(() =>
    state.blockConcurrencyWhile(() =>
      Effect.runPromiseExitWith(context)(
        Effect.andThen(
          feed.end(),
          Effect.promise(() => state.storage.deleteAll()),
        ),
      ),
    ),
  );

  return yield* exit;
}).pipe(
  // Why: once under the gate the steps run to their end, as a half-done wipe has ended its
  // subscribers and kept the data they followed; an interrupt waits for them.
  Effect.uninterruptible,
);
