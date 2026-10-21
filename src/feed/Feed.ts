import { type Cause, Context, Deferred, Effect, Layer, Option, Queue, Stream } from "effect";
import type { Rpc, RpcMessage, RpcSchema } from "effect/rpc";

/**
 * What `subscribe` reads of a stream rpc's call, which its handler's second argument holds, as
 * Effect's server gives it: `(payload, request) => feed.subscribe(request)`.
 */
export interface Subscriber<R extends Rpc.Any> {
  /** The call's id, which its client finds the call's responses by. */
  readonly requestId: RpcMessage.RequestId;
  /** The rpc called, whose chunks the subscriber is sent. */
  readonly rpc: R;
}

/**
 * The services the values of a stream rpc `R` need to encode, as its stream schema declares
 * them: what `publish` and `subscribe` of `R` owe, for a signature of the application's own,
 * such as a port publishing to `R`, to name.
 */
export type ChunkServices<R extends Rpc.Any> =
  Rpc.SuccessSchema<R> extends RpcSchema.Stream<infer A, infer _E> ? A["EncodingServices"] : never;

/** `Feed`'s `subscribe` options. */
export interface SubscribeOptions<A, E = never, R = never> {
  /**
   * What the subscriber is sent once it is read, the subscriber kept before: an Effect of the
   * values, such as a store's read of what came after the client's last, or the values. A value
   * published while it is read may arrive before it and again in it. Nothing is sent for it
   * without it, or when it is empty.
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

interface Entry {
  readonly tag: string;
  readonly key: string | undefined;
  readonly queue: Queue.Queue<unknown, Cause.Done>;
  readonly ended: Deferred.Deferred<void>;
}

/**
 * The subscribers of a server's stream rpcs, and what they are sent: a stream rpc's handler
 * returns `subscribe(request)`, making its call a subscriber, any part of the server publishes a
 * value to each subscriber of the rpc, or of a key, and `end` completes their streams.
 * `subscribe` and `publish` of an rpc owe its `ChunkServices`. An implementation is a Layer:
 * `Feed.layer` keeps the subscribers in a process's memory, and the Cloudflare package's
 * `ActionDurableObject.layerFeed` in a Durable Object's storage, across hibernation. Every
 * implementation keeps the rules below; each layer's own gotchas say what it adds.
 *
 * **Gotchas**
 *
 * - The stream `subscribe` returns is the call's, not a pipeline of what is published: an operator applied to it, such as `Stream.map`, may see none of the values, so transform a value before publishing it, or give subscribers a `key`.
 * - Every value published once a subscriber subscribed reaches it, at least once: one published while `initial` is read may arrive before it and again in it, so give values an id the client drops repeats by.
 * - Values published one after another once `initial` was sent, each `publish` completing before the next begins, arrive in that order.
 * - A subscriber whose `initial` fails ends with its failure, and is sent nothing more.
 * - `end` completes a live subscriber's stream through Effect's server, which runs its finalizers and answers its client, and the implementation answers a subscriber it no longer runs itself; one ended while its `initial` is read is interrupted and sent nothing.
 * - A subscriber has one `key`, or none: a `publish` or `end` naming a key reaches its subscribers alone, and one naming none every subscriber of the rpc; `end()` ends every subscriber of every rpc.
 * - Access is checked once, as the call subscribes: a subscriber is published to until its client interrupts it or `end` reaches it, whatever becomes of its credential or membership, so give each member's subscriptions a `key` of their own and `end(rpc, { key })` them.
 * - A client's stream fails when its connection drops, and may end with a defect, such as a chunk it cannot decode: a page observing only failures misses that end, so it reads the stream's `Exit` and subscribes again from the last value it holds, which `initial` sends on.
 *
 * Guide: `docs/Feed.md` in this package; in an application: `examples/live-rpc/`.
 */
export class Feed extends Context.Service<
  Feed,
  {
    /**
     * The stream a stream rpc's handler returns to make its call a subscriber: kept first, then
     * sent `initial` and every value published to it, until `end` completes it.
     */
    readonly subscribe: <R extends Rpc.Any, E = never, RR = never>(
      request: Subscriber<R>,
      options?: SubscribeOptions<Rpc.SuccessChunk<R>, E, RR>,
    ) => Stream.Stream<Rpc.SuccessChunk<R>, NoInfer<E>, NoInfer<RR> | ChunkServices<R>>;
    /** Sends `value` to each subscriber of `rpc`. */
    readonly publish: <R extends Rpc.Any>(
      rpc: R,
      value: Rpc.SuccessChunk<R>,
      options?: PublishOptions,
    ) => Effect.Effect<void, never, ChunkServices<R>>;
    /** Completes the stream of each subscriber of `rpc`, or of every rpc without it. */
    readonly end: {
      (): Effect.Effect<void>;
      (rpc: Rpc.Any, options?: EndOptions): Effect.Effect<void>;
    };
  }
>()("effect-actions/Feed") {}

/**
 * A feed kept in the memory of the process that builds it: each subscriber a queue the
 * server's stream reads, offered each value published to it. For a server holding its
 * clients' connections itself, such as Node's, and for tests, provided as any service.
 *
 * **Gotchas**
 *
 * - Each build is one feed: what publishes and the routes serving the stream rpc must share it, provided once around both, as beside a store; a feed provided to each separately is two, and a value published to one reaches no subscriber of the other.
 * - `initial` is sent first, as one chunk: a value published while it is read arrives after it, and again if the read saw it; values published while the client is slow to read arrive together, in one chunk.
 * - The stream carries the values here, so an operator applied to it sees them, which a durable feed's never does.
 * - Each subscriber's queue is unbounded, so a publish never waits: a client that stops reading holds every value published to it in the server's memory until its stream ends.
 * - Subscribers live in the process: a restart drops their connections, and each page subscribes again from the last value it holds.
 */
export const layer: Layer.Layer<Feed> = Layer.sync(Feed)(() => {
  const subscribers = new Set<Entry>();

  const matching = (rpc: Rpc.Any | undefined, key: string | undefined) =>
    [...subscribers].filter(
      (entry) =>
        (rpc === undefined || entry.tag === rpc._tag) && (key === undefined || entry.key === key),
    );

  return Feed.of({
    subscribe: <R extends Rpc.Any, E = never, RR = never>(
      request: Subscriber<R>,
      options?: SubscribeOptions<Rpc.SuccessChunk<R>, E, RR>,
    ) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const entry: Entry = {
            tag: request.rpc._tag,
            key: options?.key,
            queue: yield* Queue.unbounded<unknown, Cause.Done>(),
            ended: yield* Deferred.make<void>(),
          };

          // Why: kept before `initial` is read, so a value published meanwhile is queued,
          // not lost.
          subscribers.add(entry);

          yield* Effect.addFinalizer(() => Effect.sync(() => subscribers.delete(entry)));

          const initial = options?.initial ?? [];

          const read = yield* Effect.raceFirst(
            Effect.map(Effect.isEffect(initial) ? initial : Effect.succeed(initial), Option.some),
            Effect.as(Deferred.await(entry.ended), Option.none()),
          );

          return Option.match(read, {
            onNone: () => Stream.empty,
            onSome: (values) =>
              Stream.concat(
                Stream.fromArray(values),
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased rpc tag: a subscriber's queue is offered only what a publish of an rpc with its tag sends, its chunk.
                Stream.fromQueue(entry.queue) as Stream.Stream<Rpc.SuccessChunk<R>>,
              ),
          });
        }),
      ),
    publish: (rpc, value, options) =>
      Effect.suspend(() =>
        Effect.forEach(matching(rpc, options?.key), ({ queue }) => Queue.offer(queue, value), {
          discard: true,
        }),
      ),
    end: (rpc?: Rpc.Any, options?: EndOptions) =>
      Effect.suspend(() =>
        Effect.forEach(
          matching(rpc, options?.key),
          (entry) =>
            Effect.sync(() => subscribers.delete(entry)).pipe(
              Effect.andThen(Deferred.succeed(entry.ended, undefined)),
              Effect.andThen(Queue.end(entry.queue)),
            ),
          { discard: true },
        ),
      ),
  });
});
